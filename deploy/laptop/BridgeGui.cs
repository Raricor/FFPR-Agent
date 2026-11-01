// The tray app for the six bridges (0.12.0), compiled by bridge-gui.ps1 with Add-Type.
//
// Windows PowerShell 5.1's Add-Type uses the .NET Framework compiler, which only knows C# 5:
// no string interpolation, no ?., no nameof, no expression-bodied members, no auto-property
// initializers, no out var, no tuples, no pattern matching, no using static. The check project in
// gui-check/ builds this same file with LangVersion 5 on the dev box.
//
// It only ever reads: every refresh asks the bridge's local /query for {"op": "bridge"} and
// screenshots with {"op": "shot"}; it never sends key commands.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace FfprBridgeGui
{
    /// <summary>Entry point and the single-instance guard.</summary>
    public static class App
    {
        private const string MutexName = @"Local\FfprBridgeGui";
        private const string ShowEventName = @"Local\FfprBridgeGui.Show";

        /// <summary>Called by bridge-gui.ps1 with the games it found and their ports.</summary>
        [STAThread]
        public static void Run(
            string[] games,
            string[] titles,
            string[] dirs,
            int[] ports,
            string[] processes,
            string deployDir)
        {
            using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName))
            using (var mutex = new Mutex(false, MutexName))
            {
                bool owner;
                try
                {
                    owner = mutex.WaitOne(0);
                }
                catch (AbandonedMutexException)
                {
                    // The previous copy died; we are the only one now.
                    owner = true;
                }
                if (!owner)
                {
                    // Already running: ask that copy to bring its window up, then leave.
                    show.Set();
                    return;
                }

                try
                {
                    Exception failure = null;
                    var thread = new Thread(delegate()
                    {
                        try
                        {
                            Application.EnableVisualStyles();
                            Application.SetCompatibleTextRenderingDefault(false);
                            Application.Run(new MainForm(games, titles, dirs, ports, processes, deployDir, show));
                        }
                        catch (Exception e)
                        {
                            failure = e;
                        }
                    });
                    thread.SetApartmentState(ApartmentState.STA);
                    thread.Start();
                    thread.Join();
                    if (failure != null)
                    {
                        throw new InvalidOperationException("桥插件小程序退出：" + failure.Message, failure);
                    }
                }
                finally
                {
                    mutex.ReleaseMutex();
                }
            }
        }
    }

    /// <summary>The window, the tray icon and the two-second refresh.</summary>
    internal sealed class MainForm : Form
    {
        private const int QueryTimeoutMs = 1500;
        private const int RefreshMs = 2000;

        private readonly GameInfo[] _games;
        private readonly string _deployDir;
        private readonly string _root;
        private readonly EventWaitHandle _showEvent;
        private readonly ManualResetEvent _stop = new ManualResetEvent(false);

        private readonly ListView _list = new ListView();
        private readonly TabControl _tabs = new TabControl();
        private readonly RichTextBox _logBox = new RichTextBox();
        private readonly ListView _keyList = new ListView();
        private readonly PictureBox _shotBox = new PictureBox();
        private readonly RichTextBox _stateBox = new RichTextBox();
        private readonly ToolStripStatusLabel _statusLabel = new ToolStripStatusLabel("就绪");
        private readonly NotifyIcon _tray = new NotifyIcon();
        private readonly Button _launchButton = new Button();
        private readonly Button _closeButton = new Button();
        private readonly Button _shotButton = new Button();
        private readonly Button _installButton = new Button();
        private TabPage _shotPage;
        private readonly GameStatus[] _status;
        private readonly string[][] _logs;
        private readonly long[] _logStamps;
        private readonly string[] _shotFiles;
        private readonly string[] _keySignatures;
        private readonly string[] _stateSignatures;

        private Thread _worker;
        private RegisteredWaitHandle _showWait;
        private volatile bool _closing;
        private bool _exiting;
        private bool _balloonShown;
        private int _selected = -1;
        private int _logOwner = -1;
        private long _logStamp = -2;
        private int _stateOwner = -1;
        private int _keyOwner = -1;
        private int _shotOwner = -1;
        private string _shotCurrent;

        public MainForm(
            string[] games,
            string[] titles,
            string[] dirs,
            int[] ports,
            string[] processes,
            string deployDir,
            EventWaitHandle showEvent)
        {
            _deployDir = deployDir;
            _root = Path.GetFullPath(Path.Combine(deployDir, "..", ".."));
            _showEvent = showEvent;
            _games = new GameInfo[games.Length];
            for (int i = 0; i < games.Length; i++)
            {
                var game = new GameInfo();
                game.Key = games[i];
                game.Title = titles[i];
                game.Dir = dirs[i];
                game.Port = ports[i];
                game.Process = processes[i];
                _games[i] = game;
            }
            _status = new GameStatus[_games.Length];
            _logs = new string[_games.Length][];
            _logStamps = new long[_games.Length];
            _shotFiles = new string[_games.Length];
            _keySignatures = new string[_games.Length];
            _stateSignatures = new string[_games.Length];
            for (int i = 0; i < _logStamps.Length; i++)
            {
                _logStamps[i] = -2;
            }

            Text = "FFPR 桥插件";
            ClientSize = new Size(960, 640);
            MinimumSize = new Size(820, 520);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei UI", 9F);
            Icon = SystemIcons.Application;

            var root = new TableLayoutPanel();
            root.Dock = DockStyle.Fill;
            root.ColumnCount = 1;
            root.RowCount = 4;
            root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 186F));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48F));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));

            BuildList();
            root.Controls.Add(_list, 0, 0);
            root.Controls.Add(BuildButtons(), 0, 1);
            BuildTabs();
            root.Controls.Add(_tabs, 0, 2);

            var strip = new StatusStrip();
            strip.SizingGrip = false;
            strip.Dock = DockStyle.Fill;
            strip.Items.Add(_statusLabel);
            root.Controls.Add(strip, 0, 3);

            Controls.Add(root);

            BuildTray();

            var packageVersion = ReadPackageVersion();
            if (packageVersion == null)
            {
                _installButton.Enabled = false;
            }
            else
            {
                _installButton.Text = "安装桥插件 " + packageVersion;
            }

            _showWait = ThreadPool.RegisterWaitForSingleObject(
                _showEvent,
                new WaitOrTimerCallback(OnShowSignal),
                null,
                Timeout.Infinite,
                false);
        }

        private void BuildList()
        {
            _list.View = View.Details;
            _list.FullRowSelect = true;
            _list.HideSelection = false;
            _list.MultiSelect = false;
            _list.Dock = DockStyle.Fill;
            _list.Margin = new Padding(0);
            _list.Columns.Add("作品", 160);
            _list.Columns.Add("游戏", 78);
            _list.Columns.Add("桥插件", 88);
            _list.Columns.Add("端口", 62);
            _list.Columns.Add("连接", 185);
            _list.Columns.Add("挂钩", 108);
            _list.Columns.Add("运行", 92);
            _list.Columns.Add("最近按键", 178);
            for (int i = 0; i < _games.Length; i++)
            {
                var item = new ListViewItem(new string[] { _games[i].Title, "—", "—", "—", "—", "—", "—", "—" });
                item.Tag = i;
                _list.Items.Add(item);
            }
            _list.SelectedIndexChanged += new EventHandler(OnSelected);
        }

        private Control BuildButtons()
        {
            var panel = new FlowLayoutPanel();
            panel.Dock = DockStyle.Fill;
            panel.FlowDirection = FlowDirection.LeftToRight;
            panel.WrapContents = false;
            panel.Margin = new Padding(0);
            panel.Padding = new Padding(0, 6, 0, 6);

            _launchButton.Text = "后台启动";
            _launchButton.AutoSize = true;
            _launchButton.Margin = new Padding(0, 0, 8, 0);
            _launchButton.Click += new EventHandler(OnLaunch);

            _closeButton.Text = "关闭游戏";
            _closeButton.AutoSize = true;
            _closeButton.Margin = new Padding(0, 0, 8, 0);
            _closeButton.Click += new EventHandler(OnCloseGame);

            _shotButton.Text = "截图";
            _shotButton.AutoSize = true;
            _shotButton.Margin = new Padding(0, 0, 8, 0);
            _shotButton.Click += new EventHandler(OnShot);

            _installButton.Text = "安装桥插件";
            _installButton.AutoSize = true;
            _installButton.Click += new EventHandler(OnInstall);

            panel.Controls.Add(_launchButton);
            panel.Controls.Add(_closeButton);
            panel.Controls.Add(_shotButton);
            panel.Controls.Add(_installButton);
            return panel;
        }

        private void BuildTabs()
        {
            _tabs.Dock = DockStyle.Fill;
            _tabs.Margin = new Padding(0);

            var logPage = new TabPage("日志");
            _logBox.Dock = DockStyle.Fill;
            _logBox.ReadOnly = true;
            _logBox.WordWrap = false;
            _logBox.ScrollBars = RichTextBoxScrollBars.Both;
            _logBox.Font = new Font("Consolas", 9F);
            _logBox.BackColor = Color.White;
            _logBox.HideSelection = false;
            logPage.Controls.Add(_logBox);

            var keyPage = new TabPage("按键");
            _keyList.View = View.Details;
            _keyList.FullRowSelect = true;
            _keyList.MultiSelect = false;
            _keyList.Dock = DockStyle.Fill;
            _keyList.Columns.Add("时间", 90);
            _keyList.Columns.Add("谁", 160);
            _keyList.Columns.Add("方式", 90);
            _keyList.Columns.Add("按键", 300);
            _keyList.Columns.Add("结果", 240);
            keyPage.Controls.Add(_keyList);

            _shotPage = new TabPage("截图");
            _shotBox.Dock = DockStyle.Fill;
            _shotBox.SizeMode = PictureBoxSizeMode.Zoom;
            _shotBox.BackColor = Color.FromArgb(40, 40, 40);
            _shotPage.Controls.Add(_shotBox);

            var statePage = new TabPage("状态");
            _stateBox.Dock = DockStyle.Fill;
            _stateBox.ReadOnly = true;
            _stateBox.WordWrap = false;
            _stateBox.ScrollBars = RichTextBoxScrollBars.Both;
            _stateBox.Font = new Font("Consolas", 9F);
            _stateBox.BackColor = Color.White;
            _stateBox.HideSelection = false;
            statePage.Controls.Add(_stateBox);

            _tabs.TabPages.Add(logPage);
            _tabs.TabPages.Add(keyPage);
            _tabs.TabPages.Add(_shotPage);
            _tabs.TabPages.Add(statePage);
        }

        private void BuildTray()
        {
            _tray.Icon = SystemIcons.Application;
            _tray.Text = "FFPR 桥插件";
            var menu = new ContextMenuStrip();
            menu.Items.Add("显示", null, new EventHandler(OnTrayShow));
            menu.Items.Add("退出", null, new EventHandler(OnTrayExit));
            _tray.ContextMenuStrip = menu;
            _tray.DoubleClick += new EventHandler(OnTrayShow);
            _tray.Visible = true;
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (_list.Items.Count > 0 && _list.SelectedIndices.Count == 0)
            {
                _list.Items[0].Selected = true;
            }
            if (_worker == null)
            {
                _worker = new Thread(RefreshLoop);
                _worker.IsBackground = true;
                _worker.Name = "FfprBridgeGui.Refresh";
                _worker.Start();
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!_exiting && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                HideToTray();
                return;
            }
            base.OnFormClosing(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            _closing = true;
            _stop.Set();
            if (_showWait != null)
            {
                _showWait.Unregister(null);
            }
            if (_worker != null)
            {
                _worker.Join(3000);
            }
            _tray.Visible = false;
            _tray.Dispose();
            _stop.Close();
            base.OnFormClosed(e);
        }

        private void HideToTray()
        {
            Hide();
            if (!_balloonShown)
            {
                _balloonShown = true;
                _tray.ShowBalloonTip(3000, "FFPR 桥插件", "还在托盘里运行", ToolTipIcon.Info);
            }
        }

        private void OnShowSignal(object state, bool timedOut)
        {
            if (timedOut || _closing)
            {
                return;
            }
            Post(delegate() { ShowFromTray(); });
        }

        private void OnTrayShow(object sender, EventArgs e)
        {
            ShowFromTray();
        }

        private void ShowFromTray()
        {
            Show();
            if (WindowState == FormWindowState.Minimized)
            {
                WindowState = FormWindowState.Normal;
            }
            Activate();
            BringToFront();
        }

        private void OnTrayExit(object sender, EventArgs e)
        {
            _exiting = true;
            Close();
        }

        private void OnSelected(object sender, EventArgs e)
        {
            int index = SelectedIndex();
            _selected = index;
            if (index >= 0)
            {
                UpdateDetails(index);
            }
        }

        private int SelectedIndex()
        {
            if (_list.SelectedIndices.Count == 0)
            {
                return -1;
            }
            return _list.SelectedIndices[0];
        }

        private void Post(Action action)
        {
            if (_closing || IsDisposed || !IsHandleCreated)
            {
                return;
            }
            try
            {
                BeginInvoke(action);
            }
            catch (InvalidOperationException)
            {
                // The window went away between the check and the post; ObjectDisposedException
                // derives from it, so one catch covers both.
            }
        }

        private void SetStatus(string text)
        {
            _statusLabel.Text = DateTime.Now.ToString("HH:mm:ss", CultureInfo.InvariantCulture) + "  " + text;
        }

        // ---- refresh ---------------------------------------------------------------------

        private void RefreshLoop()
        {
            var clients = new BridgeClient[_games.Length];
            var logs = new LogTail[_games.Length];
            for (int i = 0; i < clients.Length; i++)
            {
                clients[i] = new BridgeClient();
                logs[i] = new LogTail();
            }
            try
            {
                while (!_closing)
                {
                    var statuses = new GameStatus[_games.Length];
                    var lines = new string[_games.Length][];
                    var stamps = new long[_games.Length];
                    for (int i = 0; i < _games.Length; i++)
                    {
                        if (_closing)
                        {
                            break;
                        }
                        statuses[i] = RefreshOne(_games[i], clients[i]);
                        logs[i].Refresh(Path.Combine(_games[i].Dir, "BepInEx", "LogOutput.log"));
                        lines[i] = logs[i].Lines;
                        stamps[i] = logs[i].Stamp;
                    }
                    if (_closing)
                    {
                        break;
                    }
                    Post(delegate() { Apply(statuses, lines, stamps); });
                    _stop.WaitOne(RefreshMs);
                }
            }
            finally
            {
                for (int i = 0; i < clients.Length; i++)
                {
                    clients[i].Dispose();
                }
            }
        }

        private static GameStatus RefreshOne(GameInfo game, BridgeClient client)
        {
            var status = new GameStatus();
            status.Port = game.Port;
            status.Running = IsRunning(game.Process);
            if (!status.Running || game.Port <= 0)
            {
                return status;
            }
            var reply = client.Query(game.Port, "bridge", QueryTimeoutMs);
            if (reply == null)
            {
                return status;
            }
            status.Reachable = true;
            var bridge = Json.Map(Json.Field(reply, "bridge"));
            if (bridge == null)
            {
                // bridge 0.11.0 and older do not know this op; the reply has no "bridge".
                return status;
            }
            status.HasBridge = true;
            status.Version = Json.Text(bridge, "version");
            status.BridgeGame = Json.Text(bridge, "game");
            status.Process = Json.Text(bridge, "process");
            status.StartedAt = Json.Time(Json.Text(bridge, "startedAt"));
            status.Port = Json.Int(Json.Field(bridge, "port"), game.Port);

            var clients = Json.Array(Json.Field(bridge, "clients"));
            if (clients != null)
            {
                var addresses = new List<string>();
                foreach (var item in clients)
                {
                    var map = Json.Map(item);
                    var record = new ClientRecord();
                    record.Remote = Json.Text(map, "remote") ?? "";
                    record.Channel = Json.Text(map, "channel") ?? "";
                    record.Since = Json.Time(Json.Text(map, "since"));
                    status.Clients.Add(record);
                    var address = AddressOf(record.Remote);
                    if (address.Length > 0 && !addresses.Contains(address))
                    {
                        addresses.Add(address);
                    }
                }
                status.ClientCount = clients.Length;
                status.ClientAddresses = string.Join("、", addresses.ToArray());
            }

            var hooks = Json.Map(Json.Field(bridge, "hooks"));
            if (hooks != null)
            {
                var ok = Json.Array(Json.Field(hooks, "ok"));
                if (ok != null)
                {
                    foreach (var item in ok)
                    {
                        status.HookOk.Add(Json.Str(item) ?? "");
                    }
                }
                var failed = Json.Array(Json.Field(hooks, "failed"));
                if (failed != null)
                {
                    foreach (var item in failed)
                    {
                        var map = Json.Map(item);
                        var record = new HookFailure();
                        record.Name = Json.Text(map, "name") ?? "";
                        record.Error = Json.Text(map, "error") ?? "";
                        status.HookFailed.Add(record);
                    }
                }
            }

            var keys = Json.Array(Json.Field(bridge, "keys"));
            if (keys != null)
            {
                foreach (var item in keys)
                {
                    var map = Json.Map(item);
                    var record = new KeyRecord();
                    record.At = Json.Time(Json.Text(map, "at"));
                    record.Sender = Json.Text(map, "from");
                    record.Remote = Json.Text(map, "remote");
                    record.Via = Json.Text(map, "via") ?? "";
                    record.Keys = JoinKeys(Json.Array(Json.Field(map, "keys")));
                    record.Ok = Json.Bool(Json.Field(map, "ok"), false);
                    record.Error = Json.Text(map, "error");
                    status.Keys.Add(record);
                }
            }

            var warnings = Json.Array(Json.Field(bridge, "warnings"));
            if (warnings != null)
            {
                foreach (var item in warnings)
                {
                    var map = Json.Map(item);
                    var record = new WarningRecord();
                    record.At = Json.Time(Json.Text(map, "at"));
                    record.Level = Json.Text(map, "level") ?? "";
                    record.Text = Json.Text(map, "text") ?? "";
                    status.Warnings.Add(record);
                }
            }
            return status;
        }

        private static bool IsRunning(string name)
        {
            if (string.IsNullOrEmpty(name))
            {
                return false;
            }
            Process[] found;
            try
            {
                found = Process.GetProcessesByName(name);
            }
            catch (Exception)
            {
                return false;
            }
            try
            {
                return found.Length > 0;
            }
            finally
            {
                foreach (var process in found)
                {
                    process.Dispose();
                }
            }
        }

        // ---- list and tabs ---------------------------------------------------------------

        private void Apply(GameStatus[] statuses, string[][] lines, long[] stamps)
        {
            for (int i = 0; i < _games.Length; i++)
            {
                _status[i] = statuses[i];
                _logs[i] = lines[i];
                _logStamps[i] = stamps[i];
                UpdateRow(i);
            }
            if (_selected >= 0)
            {
                UpdateDetails(_selected);
            }
        }

        private void UpdateRow(int index)
        {
            var item = _list.Items[index];
            var game = _games[index];
            var status = _status[index];
            item.SubItems[0].Text = game.Title;
            if (status == null)
            {
                return;
            }
            item.SubItems[1].Text = status.Running ? "运行中" : "没开";
            if (!status.Reachable)
            {
                item.SubItems[2].Text = "连不上";
            }
            else if (status.HasBridge)
            {
                item.SubItems[2].Text = string.IsNullOrEmpty(status.Version) ? "—" : status.Version;
            }
            else
            {
                item.SubItems[2].Text = "旧版";
            }
            item.SubItems[3].Text = status.Port.ToString(CultureInfo.InvariantCulture);
            if (status.ClientCount == 0)
            {
                item.SubItems[4].Text = "0 个";
            }
            else
            {
                item.SubItems[4].Text = status.ClientCount.ToString(CultureInfo.InvariantCulture)
                    + " 个(" + status.ClientAddresses + ")";
            }
            int total = status.HookOk.Count + status.HookFailed.Count;
            if (status.HookFailed.Count > 0)
            {
                item.SubItems[5].Text = status.HookOk.Count.ToString(CultureInfo.InvariantCulture)
                    + "/" + total.ToString(CultureInfo.InvariantCulture) + " 有失败";
            }
            else
            {
                item.SubItems[5].Text = status.HookOk.Count.ToString(CultureInfo.InvariantCulture)
                    + "/" + total.ToString(CultureInfo.InvariantCulture);
            }
            item.SubItems[6].Text = status.HasBridge && status.StartedAt != DateTime.MinValue
                ? Duration(DateTime.UtcNow - status.StartedAt)
                : "—";
            if (status.Keys.Count == 0)
            {
                item.SubItems[7].Text = "—";
            }
            else
            {
                var last = status.Keys[status.Keys.Count - 1];
                var who = string.IsNullOrEmpty(last.Sender) ? AddressOf(last.Remote) : last.Sender;
                item.SubItems[7].Text = Ago(last.At) + (who.Length == 0 ? "" : " · " + who);
            }

            bool hot = status.HookFailed.Count > 0 || HasRecentWarning(status);
            if (hot)
            {
                item.ForeColor = Color.Red;
            }
            else if (!status.Running)
            {
                item.ForeColor = Color.Gray;
            }
            else
            {
                item.ForeColor = SystemColors.WindowText;
            }
        }

        private static bool HasRecentWarning(GameStatus status)
        {
            var cutoff = DateTime.UtcNow.AddMinutes(-5);
            foreach (var warning in status.Warnings)
            {
                if (warning.At >= cutoff)
                {
                    return true;
                }
            }
            return false;
        }

        private void UpdateDetails(int index)
        {
            UpdateLog(index);
            UpdateKeys(index);
            UpdateState(index);
            UpdateShot(index);
        }

        private void UpdateLog(int index)
        {
            if (_logOwner == index && _logStamp == _logStamps[index])
            {
                return;
            }
            _logOwner = index;
            _logStamp = _logStamps[index];
            var lines = _logs[index];
            if (lines == null)
            {
                lines = new string[0];
            }
            Rewrite(_logBox, delegate()
            {
                foreach (var line in lines)
                {
                    Color color = Color.Black;
                    if (line.IndexOf("[Warning", StringComparison.Ordinal) >= 0)
                    {
                        color = Color.DarkOrange;
                    }
                    else if (line.IndexOf("[Error", StringComparison.Ordinal) >= 0
                        || line.IndexOf("[Fatal", StringComparison.Ordinal) >= 0)
                    {
                        color = Color.Red;
                    }
                    AppendLine(_logBox, line, color);
                }
            });
        }

        private void UpdateKeys(int index)
        {
            var status = _status[index];
            var signature = KeysSignature(status);
            if (_keyOwner == index && _keySignatures[index] == signature)
            {
                return;
            }
            _keyOwner = index;
            _keySignatures[index] = signature;
            _keyList.BeginUpdate();
            try
            {
                _keyList.Items.Clear();
                if (status == null)
                {
                    return;
                }
                // Newest first: the panel is mostly read right after pressing keys.
                for (int i = status.Keys.Count - 1; i >= 0; i--)
                {
                    var key = status.Keys[i];
                    var who = string.IsNullOrEmpty(key.Sender) ? AddressOf(key.Remote) : key.Sender;
                    string result = key.Ok ? "成功" : (string.IsNullOrEmpty(key.Error) ? "失败" : key.Error);
                    var item = new ListViewItem(new string[]
                    {
                        key.At.ToLocalTime().ToString("HH:mm:ss", CultureInfo.InvariantCulture),
                        who,
                        key.Via == "game" ? "虚拟手柄" : (key.Via ?? ""),
                        key.Keys,
                        result,
                    });
                    if (!key.Ok)
                    {
                        item.ForeColor = Color.Red;
                    }
                    _keyList.Items.Add(item);
                }
            }
            finally
            {
                _keyList.EndUpdate();
            }
        }

        private void UpdateState(int index)
        {
            var status = _status[index];
            var signature = StateSignature(status);
            if (_stateOwner == index && _stateSignatures[index] == signature)
            {
                return;
            }
            _stateOwner = index;
            _stateSignatures[index] = signature;
            Rewrite(_stateBox, delegate() { WriteState(status); });
        }

        private void WriteState(GameStatus status)
        {
            if (status == null || !status.Running)
            {
                AppendLine(_stateBox, "这一作没开。", Color.Gray);
                return;
            }
            if (!status.Reachable)
            {
                AppendLine(_stateBox, "连不上桥插件（端口 " + status.Port.ToString(CultureInfo.InvariantCulture) + "）。", Color.Gray);
                return;
            }
            if (!status.HasBridge)
            {
                AppendLine(_stateBox, "这一作装的是旧版桥插件，没有 bridge 查询。", Color.DarkOrange);
                AppendLine(_stateBox, "装 0.12.0 以后这里会显示详情。", Color.DarkOrange);
                return;
            }

            AppendLine(_stateBox, "桥插件", Color.Black);
            AppendLine(_stateBox, "  版本：" + status.Version, Color.Black);
            AppendLine(_stateBox, "  作品：" + status.BridgeGame, Color.Black);
            AppendLine(_stateBox, "  进程：" + status.Process, Color.Black);
            var started = status.StartedAt == DateTime.MinValue
                ? "—"
                : status.StartedAt.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
            AppendLine(_stateBox, "  启动：" + started, Color.Black);
            AppendLine(_stateBox, "  端口：" + status.Port.ToString(CultureInfo.InvariantCulture), Color.Black);
            AppendLine(_stateBox, "  运行："
                + (status.StartedAt == DateTime.MinValue ? "—" : Duration(DateTime.UtcNow - status.StartedAt)), Color.Black);
            AppendLine(_stateBox, "", Color.Black);

            AppendLine(_stateBox, "挂钩（" + status.HookOk.Count.ToString(CultureInfo.InvariantCulture)
                + " 成功，" + status.HookFailed.Count.ToString(CultureInfo.InvariantCulture) + " 失败）", Color.Black);
            if (status.HookOk.Count > 0)
            {
                AppendLine(_stateBox, "  成功：" + string.Join("、", status.HookOk.ToArray()), Color.Black);
            }
            if (status.HookFailed.Count == 0)
            {
                AppendLine(_stateBox, "  失败：无", Color.Black);
            }
            else
            {
                foreach (var failure in status.HookFailed)
                {
                    AppendLine(_stateBox, "  失败：" + failure.Name + "  " + failure.Error, Color.Red);
                }
            }
            AppendLine(_stateBox, "", Color.Black);

            AppendLine(_stateBox, "客户端（" + status.ClientCount.ToString(CultureInfo.InvariantCulture) + "）", Color.Black);
            if (status.ClientCount == 0)
            {
                AppendLine(_stateBox, "  没有连接", Color.Black);
            }
            else
            {
                foreach (var client in status.Clients)
                {
                    AppendLine(_stateBox, "  " + client.Remote + "  " + ChannelName(client.Channel)
                        + "  " + client.Since.ToLocalTime().ToString("HH:mm:ss", CultureInfo.InvariantCulture), Color.Black);
                }
            }
            AppendLine(_stateBox, "", Color.Black);

            AppendLine(_stateBox, "警告（最近 " + status.Warnings.Count.ToString(CultureInfo.InvariantCulture) + " 条）", Color.Black);
            if (status.Warnings.Count == 0)
            {
                AppendLine(_stateBox, "  没有", Color.Black);
            }
            else
            {
                foreach (var warning in status.Warnings)
                {
                    Color color = warning.Level == "Warning" ? Color.DarkOrange : Color.Red;
                    AppendLine(_stateBox, "  "
                        + warning.At.ToLocalTime().ToString("HH:mm:ss", CultureInfo.InvariantCulture)
                        + "  " + warning.Level + "  " + warning.Text, color);
                }
            }
        }

        private void UpdateShot(int index)
        {
            var file = _shotFiles[index];
            if (_shotOwner == index && string.Equals(_shotCurrent, file, StringComparison.Ordinal))
            {
                return;
            }
            _shotOwner = index;
            _shotCurrent = file;
            var old = _shotBox.Image;
            _shotBox.Image = null;
            if (old != null)
            {
                old.Dispose();
            }
            if (string.IsNullOrEmpty(file) || !File.Exists(file))
            {
                return;
            }
            try
            {
                _shotBox.Image = LoadImage(file);
            }
            catch (Exception)
            {
                // The game may still be writing the PNG; the next shot refresh tries again.
            }
        }

        private static Image LoadImage(string path)
        {
            byte[] bytes;
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (var memory = new MemoryStream())
            {
                stream.CopyTo(memory);
                bytes = memory.ToArray();
            }
            using (var memory = new MemoryStream(bytes))
            using (var image = Image.FromStream(memory))
            {
                return new Bitmap(image);
            }
        }

        // ---- buttons ---------------------------------------------------------------------

        private void OnLaunch(object sender, EventArgs e)
        {
            int index = SelectedIndex();
            if (index < 0)
            {
                SetStatus("先在列表里选一作");
                return;
            }
            var game = _games[index];
            SetStatus("正在后台启动 " + game.Title + " …");
            var script = Path.Combine(_deployDir, "launch-game.ps1");
            RunInBackground(delegate()
            {
                int code;
                string output = RunScript(script, "-Game " + game.Key, out code);
                var message = output.Trim();
                if (message.Length == 0)
                {
                    message = "启动脚本结束，退出码 " + code.ToString(CultureInfo.InvariantCulture);
                }
                else if (code != 0)
                {
                    message = "启动失败：" + message;
                }
                Post(delegate() { SetStatus(message); });
            });
        }

        private void OnCloseGame(object sender, EventArgs e)
        {
            int index = SelectedIndex();
            if (index < 0)
            {
                SetStatus("先在列表里选一作");
                return;
            }
            var game = _games[index];
            var answer = MessageBox.Show(
                this,
                "关闭 " + game.Key.ToUpperInvariant() + "？没存档的进度会丢失。",
                "关闭游戏",
                MessageBoxButtons.OKCancel,
                MessageBoxIcon.Warning);
            if (answer != DialogResult.OK)
            {
                return;
            }
            SetStatus("正在关闭 " + game.Title + " …");
            RunInBackground(delegate()
            {
                string message = CloseGame(game.Process);
                Post(delegate() { SetStatus(message); });
            });
        }

        private void OnShot(object sender, EventArgs e)
        {
            int index = SelectedIndex();
            if (index < 0)
            {
                SetStatus("先在列表里选一作");
                return;
            }
            var game = _games[index];
            var status = _status[index];
            if (status == null || !status.Running)
            {
                SetStatus("这一作没在运行");
                return;
            }
            SetStatus("正在截图 …");
            RunInBackground(delegate()
            {
                string file = null;
                string error = null;
                try
                {
                    using (var client = new BridgeClient())
                    {
                        var reply = client.Query(game.Port, "shot", QueryTimeoutMs);
                        if (reply == null)
                        {
                            error = "连不上桥插件";
                        }
                        else if (!Json.Bool(Json.Field(reply, "ok"), false))
                        {
                            error = Json.Text(reply, "error") ?? "桥插件拒绝了截图";
                        }
                        else
                        {
                            var shot = Json.Map(Json.Field(reply, "shot"));
                            file = Json.Text(shot, "file");
                            if (string.IsNullOrEmpty(file))
                            {
                                error = "回复里没有截图路径";
                            }
                        }
                    }
                    if (!string.IsNullOrEmpty(file))
                    {
                        // Unity writes the frame itself at the end of this frame.
                        var deadline = DateTime.UtcNow.AddSeconds(3);
                        while (!File.Exists(file) && DateTime.UtcNow < deadline)
                        {
                            Thread.Sleep(50);
                        }
                        if (!File.Exists(file))
                        {
                            error = "没等到截图文件：" + file;
                            file = null;
                        }
                    }
                }
                catch (Exception ex)
                {
                    error = ex.Message;
                }
                if (!string.IsNullOrEmpty(file))
                {
                    var path = file;
                    Post(delegate()
                    {
                        _shotFiles[index] = path;
                        UpdateShot(index);
                        _tabs.SelectedTab = _shotPage;
                        SetStatus("截图已更新");
                    });
                }
                else
                {
                    var message = error == null ? "截图失败" : ("截图失败：" + error);
                    Post(delegate() { SetStatus(message); });
                }
            });
        }

        private void OnInstall(object sender, EventArgs e)
        {
            if (!IsPackageAvailable())
            {
                SetStatus("C:\\ffpr\\staging\\bridge\\FfprBridge\\ 里没有包");
                return;
            }
            _installButton.Enabled = false;
            SetStatus("正在安装桥插件 …");
            var script = Path.Combine(_deployDir, "install-bridge.ps1");
            var games = new StringBuilder();
            for (int i = 0; i < _games.Length; i++)
            {
                if (i > 0)
                {
                    games.Append(',');
                }
                games.Append(_games[i].Key);
            }
            RunInBackground(delegate()
            {
                int code;
                string output = RunScript(script, "-Games " + games.ToString(), out code).Trim();
                if (output.Length == 0)
                {
                    output = "(没有输出)";
                }
                output += Environment.NewLine + Environment.NewLine
                    + "退出码 " + code.ToString(CultureInfo.InvariantCulture);
                Post(delegate()
                {
                    _installButton.Enabled = true;
                    ShowText("安装桥插件", output);
                    SetStatus(code == 0 ? "安装完成" : "安装结束，有作品没装上");
                });
            });
        }

        private static string CloseGame(string name)
        {
            Process[] found;
            try
            {
                found = Process.GetProcessesByName(name);
            }
            catch (Exception e)
            {
                return "找不到进程：" + e.Message;
            }
            if (found.Length == 0)
            {
                return "这一作没在运行";
            }
            try
            {
                foreach (var process in found)
                {
                    try
                    {
                        if (process.MainWindowHandle != IntPtr.Zero)
                        {
                            process.CloseMainWindow();
                        }
                    }
                    catch (Exception)
                    {
                        // It may have exited between the lookup and the close.
                    }
                }
                var deadline = DateTime.UtcNow.AddSeconds(10);
                bool alive = true;
                while (alive && DateTime.UtcNow < deadline)
                {
                    alive = false;
                    foreach (var process in found)
                    {
                        try
                        {
                            if (!process.HasExited)
                            {
                                alive = true;
                                break;
                            }
                        }
                        catch (Exception)
                        {
                        }
                    }
                    if (alive)
                    {
                        Thread.Sleep(200);
                    }
                }
                if (!alive)
                {
                    return "已关闭";
                }
                foreach (var process in found)
                {
                    try
                    {
                        if (!process.HasExited)
                        {
                            process.Kill();
                        }
                    }
                    catch (Exception)
                    {
                    }
                }
                return "10 秒内没退出，已强制结束";
            }
            finally
            {
                foreach (var process in found)
                {
                    process.Dispose();
                }
            }
        }

        private static void RunInBackground(ThreadStart work)
        {
            var thread = new Thread(work);
            thread.IsBackground = true;
            thread.Start();
        }

        /// <summary>Runs a laptop script and reads its output as UTF-8, so Chinese is not garbled.</summary>
        private static string RunScript(string script, string arguments, out int exitCode)
        {
            try
            {
                return RunScriptCore(script, arguments, out exitCode);
            }
            catch (Exception e)
            {
                exitCode = -1;
                return "运行脚本失败：" + e.Message;
            }
        }

        private static string RunScriptCore(string script, string arguments, out int exitCode)
        {
            var info = new ProcessStartInfo();
            info.FileName = "powershell.exe";
            info.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command \"[Console]::OutputEncoding = [Text.Encoding]::UTF8; & '"
                + script + "'" + (arguments.Length == 0 ? "" : " " + arguments) + "; exit $LASTEXITCODE\"";
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8;
            info.StandardErrorEncoding = Encoding.UTF8;

            var output = new StringBuilder();
            var error = new StringBuilder();
            using (var process = new Process())
            {
                process.StartInfo = info;
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
                {
                    if (e.Data != null)
                    {
                        lock (output)
                        {
                            output.AppendLine(e.Data);
                        }
                    }
                };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
                {
                    if (e.Data != null)
                    {
                        lock (error)
                        {
                            error.AppendLine(e.Data);
                        }
                    }
                };
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                bool exited = process.WaitForExit(180000);
                if (!exited)
                {
                    try
                    {
                        process.Kill();
                    }
                    catch (Exception)
                    {
                    }
                    process.WaitForExit(5000);
                    exitCode = -1;
                    return "脚本 180 秒内没结束，已经结束它";
                }
                process.WaitForExit();
                exitCode = process.ExitCode;
            }
            string text;
            lock (output)
            {
                text = output.ToString();
            }
            string errors;
            lock (error)
            {
                errors = error.ToString();
            }
            if (errors.Length > 0)
            {
                text = text.Length == 0 ? errors : text + Environment.NewLine + errors;
            }
            return text;
        }

        private void ShowText(string title, string text)
        {
            using (var dialog = new Form())
            {
                dialog.Text = title;
                dialog.StartPosition = FormStartPosition.CenterParent;
                dialog.ClientSize = new Size(640, 420);
                dialog.MinimizeBox = false;
                dialog.MaximizeBox = false;
                dialog.ShowInTaskbar = false;
                var box = new TextBox();
                box.Multiline = true;
                box.ReadOnly = true;
                box.ScrollBars = ScrollBars.Both;
                box.WordWrap = false;
                box.Dock = DockStyle.Fill;
                box.Font = new Font("Consolas", 9F);
                box.Text = text;
                var close = new Button();
                close.Text = "关闭";
                close.DialogResult = DialogResult.OK;
                close.Dock = DockStyle.Bottom;
                close.Height = 34;
                dialog.Controls.Add(box);
                dialog.Controls.Add(close);
                dialog.AcceptButton = close;
                dialog.ShowDialog(this);
            }
        }

        // ---- package ---------------------------------------------------------------------

        private string ReadPackageVersion()
        {
            var file = Path.Combine(_root, "staging", "bridge", "FfprBridge", "version.txt");
            try
            {
                if (!File.Exists(file))
                {
                    return null;
                }
                var text = File.ReadAllText(file, Encoding.UTF8).Trim();
                return text.Length == 0 ? null : text;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private bool IsPackageAvailable()
        {
            var file = Path.Combine(_root, "staging", "bridge", "FfprBridge", "version.txt");
            return File.Exists(file);
        }

        // ---- text helpers ----------------------------------------------------------------

        private static void Rewrite(RichTextBox box, Action fill)
        {
            bool bottom = AtBottom(box);
            int first = box.TextLength > 0 ? box.GetCharIndexFromPosition(new Point(1, 1)) : 0;
            box.SuspendLayout();
            box.Clear();
            fill();
            box.ResumeLayout();
            box.SelectionLength = 0;
            if (bottom)
            {
                box.SelectionStart = box.TextLength;
                box.ScrollToCaret();
            }
            else
            {
                box.SelectionStart = Math.Min(first, box.TextLength);
                box.ScrollToCaret();
            }
            box.SelectionLength = 0;
        }

        private static void AppendLine(RichTextBox box, string text, Color color)
        {
            box.SelectionStart = box.TextLength;
            box.SelectionLength = 0;
            box.SelectionColor = color;
            box.AppendText(text + Environment.NewLine);
        }

        private static bool AtBottom(RichTextBox box)
        {
            if (box.TextLength == 0)
            {
                return true;
            }
            // GetPositionFromCharIndex counts from the top of the client area and moves with the
            // scroll: when the user is looking further up, the last character is below the box.
            var last = box.GetPositionFromCharIndex(box.TextLength - 1);
            return last.Y <= box.ClientSize.Height;
        }

        private static string KeysSignature(GameStatus status)
        {
            if (status == null)
            {
                return "";
            }
            var text = new StringBuilder();
            text.Append(status.Keys.Count);
            if (status.Keys.Count > 0)
            {
                var last = status.Keys[status.Keys.Count - 1];
                text.Append('|').Append(last.At.Ticks).Append('|').Append(last.Keys);
            }
            return text.ToString();
        }

        private static string StateSignature(GameStatus status)
        {
            if (status == null)
            {
                return "";
            }
            var text = new StringBuilder();
            text.Append(status.Running).Append(status.Reachable).Append(status.HasBridge);
            text.Append('|').Append(status.Version).Append('|').Append(status.StartedAt.Ticks);
            text.Append('|').Append(status.HookOk.Count).Append(',').Append(status.HookFailed.Count);
            text.Append('|').Append(status.ClientCount);
            if (status.Clients.Count > 0)
            {
                text.Append('|').Append(status.Clients[status.Clients.Count - 1].Since.Ticks);
            }
            text.Append('|').Append(status.Warnings.Count);
            if (status.Warnings.Count > 0)
            {
                text.Append('|').Append(status.Warnings[status.Warnings.Count - 1].At.Ticks);
            }
            return text.ToString();
        }

        private static string JoinKeys(object[] keys)
        {
            if (keys == null || keys.Length == 0)
            {
                return "";
            }
            var parts = new string[keys.Length];
            for (int i = 0; i < keys.Length; i++)
            {
                parts[i] = Json.Str(keys[i]) ?? "";
            }
            return string.Join(" ", parts);
        }

        private static string ChannelName(string channel)
        {
            if (channel == "stream")
            {
                return "广播";
            }
            if (channel == "query")
            {
                return "查询";
            }
            if (channel == "command")
            {
                return "按键";
            }
            return channel ?? "";
        }

        /// <summary>"host:port" to "host"; the bridge always reports an IP endpoint.</summary>
        private static string AddressOf(string remote)
        {
            if (string.IsNullOrEmpty(remote))
            {
                return "";
            }
            int colon = remote.LastIndexOf(':');
            return colon > 0 ? remote.Substring(0, colon) : remote;
        }

        private static string Duration(TimeSpan span)
        {
            if (span < TimeSpan.Zero)
            {
                span = TimeSpan.Zero;
            }
            if (span.TotalDays >= 1)
            {
                return ((int)span.TotalDays).ToString(CultureInfo.InvariantCulture)
                    + " 天 " + span.Hours.ToString(CultureInfo.InvariantCulture) + " 时";
            }
            if (span.TotalHours >= 1)
            {
                return ((int)span.TotalHours).ToString(CultureInfo.InvariantCulture)
                    + " 时 " + span.Minutes.ToString(CultureInfo.InvariantCulture) + " 分";
            }
            return ((int)span.TotalMinutes).ToString(CultureInfo.InvariantCulture) + " 分";
        }

        private static string Ago(DateTime time)
        {
            if (time == DateTime.MinValue)
            {
                return "—";
            }
            var span = DateTime.UtcNow - time.ToUniversalTime();
            if (span.TotalSeconds < 5)
            {
                return "刚刚";
            }
            if (span.TotalMinutes < 1)
            {
                return ((int)span.TotalSeconds).ToString(CultureInfo.InvariantCulture) + " 秒前";
            }
            if (span.TotalHours < 1)
            {
                return ((int)span.TotalMinutes).ToString(CultureInfo.InvariantCulture) + " 分前";
            }
            if (span.TotalDays < 1)
            {
                return ((int)span.TotalHours).ToString(CultureInfo.InvariantCulture)
                    + " 时 " + span.Minutes.ToString(CultureInfo.InvariantCulture) + " 分前";
            }
            return ((int)span.TotalDays).ToString(CultureInfo.InvariantCulture) + " 天前";
        }

    }

    /// <summary>The last /query connection to one bridge; reconnects after a timeout.</summary>
    internal sealed class BridgeClient : IDisposable
    {
        private const int MaxReplyBytes = 4 * 1024 * 1024;

        private readonly object _gate = new object();
        private ClientWebSocket _socket;
        private int _id;

        public Dictionary<string, object> Query(int port, string op, int timeoutMs)
        {
            lock (_gate)
            {
                try
                {
                    using (var cts = new CancellationTokenSource(timeoutMs))
                    {
                        var token = cts.Token;
                        if (_socket == null)
                        {
                            var socket = new ClientWebSocket();
                            try
                            {
                                socket.ConnectAsync(
                                    new Uri("ws://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture) + "/query"),
                                    token).GetAwaiter().GetResult();
                            }
                            catch (Exception)
                            {
                                socket.Dispose();
                                throw;
                            }
                            _socket = socket;
                        }
                        var id = ++_id;
                        var body = "{\"id\":" + id.ToString(CultureInfo.InvariantCulture)
                            + ",\"op\":\"" + op + "\"}";
                        var bytes = Encoding.UTF8.GetBytes(body);
                        _socket.SendAsync(
                            new ArraySegment<byte>(bytes),
                            WebSocketMessageType.Text,
                            true,
                            token).GetAwaiter().GetResult();
                        var buffer = new byte[8192];
                        var message = new MemoryStream();
                        while (true)
                        {
                            var result = _socket.ReceiveAsync(new ArraySegment<byte>(buffer), token)
                                .GetAwaiter().GetResult();
                            if (result.MessageType == WebSocketMessageType.Close)
                            {
                                throw new IOException("closed");
                            }
                            message.Write(buffer, 0, result.Count);
                            if (message.Length > MaxReplyBytes)
                            {
                                throw new IOException("reply too large");
                            }
                            if (!result.EndOfMessage)
                            {
                                continue;
                            }
                            var text = Encoding.UTF8.GetString(message.ToArray());
                            message.SetLength(0);
                            var reply = new JavaScriptSerializer().DeserializeObject(text)
                                as Dictionary<string, object>;
                            // The bridge sends "hello" first on every connection; skip it.
                            if (reply != null
                                && Json.Text(reply, "type") == "reply"
                                && Json.Int(Json.Field(reply, "re"), -1) == id)
                            {
                                return reply;
                            }
                        }
                    }
                }
                catch (Exception)
                {
                    DisposeSocket();
                    return null;
                }
            }
        }

        public void Dispose()
        {
            lock (_gate)
            {
                DisposeSocket();
            }
        }

        private void DisposeSocket()
        {
            if (_socket == null)
            {
                return;
            }
            try
            {
                _socket.Dispose();
            }
            catch (Exception)
            {
            }
            _socket = null;
        }
    }

    /// <summary>Reads the tail of BepInEx/LogOutput.log without disturbing the running game.</summary>
    internal sealed class LogTail
    {
        private const int MaxLines = 300;
        private const int MaxBytes = 256 * 1024;

        public string[] Lines = new string[0];
        public long Stamp = -1;

        private long _length = -1;
        private DateTime _modified = DateTime.MinValue;

        public void Refresh(string path)
        {
            try
            {
                var info = new FileInfo(path);
                if (!info.Exists)
                {
                    if (Stamp != -1)
                    {
                        Stamp = -1;
                        Lines = new string[0];
                    }
                    return;
                }
                if (info.Length == _length && info.LastWriteTimeUtc == _modified)
                {
                    return;
                }
                _length = info.Length;
                _modified = info.LastWriteTimeUtc;
                Lines = ReadTail(path, info.Length);
                Stamp = info.Length ^ info.LastWriteTimeUtc.Ticks;
            }
            catch (Exception)
            {
                // The game keeps the log open for writing; a failed read keeps the old lines.
            }
        }

        private static string[] ReadTail(string path, long length)
        {
            long start = Math.Max(0, length - MaxBytes);
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                stream.Seek(start, SeekOrigin.Begin);
                using (var reader = new StreamReader(stream, Encoding.UTF8, true))
                {
                    var text = reader.ReadToEnd();
                    if (start > 0)
                    {
                        int newline = text.IndexOf('\n');
                        text = newline >= 0 ? text.Substring(newline + 1) : "";
                    }
                    text = text.Replace("\r\n", "\n").Replace('\r', '\n');
                    var all = text.Split(new char[] { '\n' });
                    int end = all.Length;
                    if (end > 0 && all[end - 1].Length == 0)
                    {
                        end--;
                    }
                    int first = Math.Max(0, end - MaxLines);
                    var lines = new string[end - first];
                    Array.Copy(all, first, lines, 0, lines.Length);
                    return lines;
                }
            }
        }
    }

    internal sealed class GameInfo
    {
        public string Key;
        public string Title;
        public string Dir;
        public int Port;
        public string Process;
    }

    internal sealed class GameStatus
    {
        public bool Running;
        public bool Reachable;
        public bool HasBridge;
        public string Version;
        public string BridgeGame;
        public string Process;
        public DateTime StartedAt;
        public int Port;
        public int ClientCount;
        public string ClientAddresses;
        public readonly List<string> HookOk = new List<string>();
        public readonly List<HookFailure> HookFailed = new List<HookFailure>();
        public readonly List<KeyRecord> Keys = new List<KeyRecord>();
        public readonly List<WarningRecord> Warnings = new List<WarningRecord>();
        public readonly List<ClientRecord> Clients = new List<ClientRecord>();
    }

    internal sealed class HookFailure
    {
        public string Name;
        public string Error;
    }

    internal sealed class KeyRecord
    {
        public DateTime At;
        public string Sender;
        public string Remote;
        public string Via;
        public string Keys;
        public bool Ok;
        public string Error;
    }

    internal sealed class WarningRecord
    {
        public DateTime At;
        public string Level;
        public string Text;
    }

    internal sealed class ClientRecord
    {
        public string Remote;
        public string Channel;
        public DateTime Since;
    }

    /// <summary>JavaScriptSerializer hands back Dictionary&lt;string, object&gt; and object[].</summary>
    internal static class Json
    {
        public static Dictionary<string, object> Map(object value)
        {
            return value as Dictionary<string, object>;
        }

        public static object[] Array(object value)
        {
            return value as object[];
        }

        public static object Field(Dictionary<string, object> map, string key)
        {
            if (map == null)
            {
                return null;
            }
            object value;
            return map.TryGetValue(key, out value) ? value : null;
        }

        public static string Text(Dictionary<string, object> map, string key)
        {
            return Str(Field(map, key));
        }

        public static string Str(object value)
        {
            return value == null ? null : Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        public static int Int(object value, int fallback)
        {
            if (value == null)
            {
                return fallback;
            }
            try
            {
                return Convert.ToInt32(value, CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                return fallback;
            }
        }

        public static bool Bool(object value, bool fallback)
        {
            if (value is bool)
            {
                return (bool)value;
            }
            return fallback;
        }

        public static DateTime Time(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return DateTime.MinValue;
            }
            DateTime value;
            if (DateTime.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out value))
            {
                return value;
            }
            return DateTime.MinValue;
        }
    }
}
