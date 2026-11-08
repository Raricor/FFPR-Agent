// The tray app for the six bridges (0.14.0), compiled by bridge-gui.ps1 with Add-Type.
//
// Windows PowerShell 5.1's Add-Type uses the .NET Framework compiler, which only knows C# 5:
// no string interpolation, no ?., no nameof, no expression-bodied members, no auto-property
// initializers, no out var, no tuples, no pattern matching, no using static. The check project in
// gui-check/ builds this same file with LangVersion 5 on the dev box.
//
// It only ever reads: every refresh asks the bridge's local /query for {"op": "bridge"},
// {"op": "shot"}, {"op": "walk"}, {"op": "collision"} and {"op": "cells"}; it never sends key
// commands.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
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

        /// <summary>Called by bridge-gui.ps1 with all six games; an empty dir means not installed.</summary>
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

    /// <summary>Every colour and font the window uses; nothing chooses its own.</summary>
    internal static class Theme
    {
        public static readonly Color Background = ColorTranslator.FromHtml("#1E1F22");
        public static readonly Color Panel = ColorTranslator.FromHtml("#2B2D30");
        public static readonly Color PanelAlt = ColorTranslator.FromHtml("#303236");
        public static readonly Color Header = ColorTranslator.FromHtml("#26282B");
        public static readonly Color Hover = ColorTranslator.FromHtml("#34373B");
        public static readonly Color BorderHover = ColorTranslator.FromHtml("#4A4E52");
        public static readonly Color DangerHover = ColorTranslator.FromHtml("#3A292C");
        public static readonly Color Pressed = ColorTranslator.FromHtml("#26282B");
        public static readonly Color Selection = ColorTranslator.FromHtml("#31445F");
        public static readonly Color Border = ColorTranslator.FromHtml("#3C3F41");
        public static readonly Color Text = ColorTranslator.FromHtml("#DFE1E5");
        public static readonly Color Muted = ColorTranslator.FromHtml("#9DA0A8");
        public static readonly Color MutedFaint = Color.FromArgb(70, 157, 160, 168);
        public static readonly Color Accent = ColorTranslator.FromHtml("#5B9BFF");
        public static readonly Color AccentSoft = Color.FromArgb(150, 91, 155, 255);
        public static readonly Color Running = ColorTranslator.FromHtml("#4CC38A");
        public static readonly Color Warning = ColorTranslator.FromHtml("#F2B84B");
        public static readonly Color Error = ColorTranslator.FromHtml("#F2555A");
        public static readonly Color Idle = ColorTranslator.FromHtml("#6F737A");

        public static readonly Color MapFloor = ColorTranslator.FromHtml("#2B2D30");
        public static readonly Color MapWalk = ColorTranslator.FromHtml("#24262A");
        public static readonly Color MapWall = ColorTranslator.FromHtml("#17181A");
        public static readonly Color MapSea = ColorTranslator.FromHtml("#16324F");
        public static readonly Color MapMountain = ColorTranslator.FromHtml("#4A423A");
        public static readonly Color MapGrass = ColorTranslator.FromHtml("#2E4030");
        public static readonly Color MapLand = ColorTranslator.FromHtml("#2B2D30");
        public static readonly Color MapGrid = Color.FromArgb(36, 255, 255, 255);

        public static readonly Font Body = new Font("Microsoft YaHei UI", 10F);
        public static readonly Font BodyBold = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold);
        public static readonly Font Title = new Font("Microsoft YaHei UI", 12F, FontStyle.Bold);
        public static readonly Font Small = new Font("Microsoft YaHei UI", 9F);
        public static readonly Font Caption = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold);
        public static readonly Font Mono = new Font("Consolas", 9.5F);
        public static readonly Font MonoSmall = new Font("Consolas", 9F);
    }

    /// <summary>A flat dark button with hover, pressed, disabled and danger states.</summary>
    internal sealed class FlatButton : Control
    {
        private bool _hover;
        private bool _down;
        private bool _danger;

        public FlatButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
                | ControlStyles.Selectable, true);
            SetStyle(ControlStyles.StandardClick, false);
            BackColor = Theme.Panel;
            ForeColor = Theme.Text;
            Font = Theme.Body;
            Cursor = Cursors.Hand;
            TabStop = true;
            AutoSize = true;
        }

        public bool Danger
        {
            get { return _danger; }
            set
            {
                if (_danger != value)
                {
                    _danger = value;
                    Invalidate();
                }
            }
        }

        public override Size GetPreferredSize(Size proposedSize)
        {
            Size text = TextRenderer.MeasureText(Text ?? "", Font);
            int width = text.Width + 34;
            if (width < 76)
            {
                width = 76;
            }
            int height = text.Height + 14;
            if (height < 34)
            {
                height = 34;
            }
            return new Size(width, height);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Color fill;
            Color border;
            Color text;
            if (!Enabled)
            {
                fill = Theme.Pressed;
                border = Theme.Border;
                text = Theme.Idle;
            }
            else if (_down)
            {
                fill = Theme.Pressed;
                border = _danger ? Theme.Error : Theme.Border;
                text = _danger ? Theme.Error : Theme.Text;
            }
            else if (_hover)
            {
                fill = _danger ? Theme.DangerHover : Theme.Hover;
                border = _danger ? Theme.Error : Theme.BorderHover;
                text = _danger ? Theme.Error : Theme.Text;
            }
            else
            {
                fill = Theme.Panel;
                border = _danger ? Theme.Error : Theme.Border;
                text = _danger ? Theme.Error : Theme.Text;
            }

            var rect = new Rectangle(0, 0, Width - 1, Height - 1);
            using (var path = RoundRect(rect, 6))
            using (var brush = new SolidBrush(fill))
            using (var pen = new Pen(border, 1F))
            {
                e.Graphics.FillPath(brush, path);
                e.Graphics.DrawPath(pen, path);
            }
            TextRenderer.DrawText(
                e.Graphics,
                Text ?? "",
                Font,
                rect,
                text,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter
                    | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            _hover = true;
            Invalidate();
            base.OnMouseEnter(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            _hover = false;
            _down = false;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left && Enabled)
            {
                _down = true;
                Capture = true;
                Invalidate();
            }
            base.OnMouseDown(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left)
            {
                bool click = _down && ClientRectangle.Contains(e.Location);
                _down = false;
                Capture = false;
                Invalidate();
                if (click && Enabled)
                {
                    OnClick(EventArgs.Empty);
                }
            }
            base.OnMouseUp(e);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (Enabled && (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter))
            {
                OnClick(EventArgs.Empty);
                e.Handled = true;
            }
            base.OnKeyDown(e);
        }

        protected override void OnEnabledChanged(EventArgs e)
        {
            _hover = false;
            _down = false;
            Invalidate();
            base.OnEnabledChanged(e);
        }

        internal static GraphicsPath RoundRect(Rectangle rect, int radius)
        {
            var path = new GraphicsPath();
            int d = radius * 2;
            if (d > rect.Width)
            {
                d = rect.Width;
            }
            if (d > rect.Height)
            {
                d = rect.Height;
            }
            if (d < 2)
            {
                path.AddRectangle(rect);
                return path;
            }
            path.AddArc(rect.X, rect.Y, d, d, 180F, 90F);
            path.AddArc(rect.Right - d, rect.Y, d, d, 270F, 90F);
            path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0F, 90F);
            path.AddArc(rect.X, rect.Bottom - d, d, d, 90F, 90F);
            path.CloseFigure();
            return path;
        }
    }

    /// <summary>The left navigation column; drawn by hand so no system tab header appears.</summary>
    internal sealed class NavBar : Control
    {
        private const int TopPad = 14;
        private const int ItemHeight = 46;

        private readonly string[] _items;
        private int _selected;
        private int _hover = -1;

        public NavBar()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
                | ControlStyles.Selectable, true);
            _items = new string[] { "走路", "截图", "按键", "日志", "状态" };
            BackColor = Theme.Background;
            ForeColor = Theme.Muted;
            Font = Theme.Body;
            Cursor = Cursors.Hand;
            TabStop = true;
        }

        public event EventHandler SelectedIndexChanged;

        public int SelectedIndex
        {
            get { return _selected; }
            set
            {
                int index = value;
                if (index < 0)
                {
                    index = 0;
                }
                if (index >= _items.Length)
                {
                    index = _items.Length - 1;
                }
                if (index != _selected)
                {
                    _selected = index;
                    Invalidate();
                    var handler = SelectedIndexChanged;
                    if (handler != null)
                    {
                        handler(this, EventArgs.Empty);
                    }
                }
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Theme.Background);
            using (var pen = new Pen(Theme.Border, 1F))
            {
                e.Graphics.DrawLine(pen, Width - 1, 0, Width - 1, Height);
            }
            for (int i = 0; i < _items.Length; i++)
            {
                var row = new Rectangle(0, TopPad + i * ItemHeight, Width - 1, ItemHeight - 1);
                if (i == _selected)
                {
                    using (var brush = new SolidBrush(Theme.Panel))
                    {
                        e.Graphics.FillRectangle(brush, row);
                    }
                    using (var brush = new SolidBrush(Theme.Accent))
                    {
                        e.Graphics.FillRectangle(brush, 0, row.Y + 9, 3, row.Height - 18);
                    }
                }
                else if (i == _hover)
                {
                    using (var brush = new SolidBrush(Theme.Header))
                    {
                        e.Graphics.FillRectangle(brush, row);
                    }
                }
                Color color = i == _selected ? Theme.Text : Theme.Muted;
                string text = i == _selected ? "▸ " + _items[i] : "   " + _items[i];
                TextRenderer.DrawText(
                    e.Graphics,
                    text,
                    Font,
                    new Rectangle(18, row.Y, row.Width - 24, row.Height),
                    color,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter
                        | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
            }
        }

        private int HitTest(Point point)
        {
            int y = point.Y - TopPad;
            if (y < 0)
            {
                return -1;
            }
            int index = y / ItemHeight;
            if (index < 0 || index >= _items.Length || point.X >= Width - 3)
            {
                return -1;
            }
            return index;
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            int index = HitTest(e.Location);
            if (index != _hover)
            {
                _hover = index;
                Invalidate();
            }
            base.OnMouseMove(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            if (_hover != -1)
            {
                _hover = -1;
                Invalidate();
            }
            base.OnMouseLeave(e);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left)
            {
                int index = HitTest(e.Location);
                if (index >= 0)
                {
                    SelectedIndex = index;
                }
            }
            base.OnMouseDown(e);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Down)
            {
                SelectedIndex = _selected + 1;
                e.Handled = true;
            }
            else if (e.KeyCode == Keys.Up)
            {
                SelectedIndex = _selected - 1;
                e.Handled = true;
            }
            base.OnKeyDown(e);
        }
    }

    /// <summary>The dark strip at the top: dot, work, bridge version, connections, run time.</summary>
    internal sealed class HeaderBar : Control
    {
        public string GameTitle = "FFPR 桥插件";
        public string StateText = "未运行";
        public Color StateColor = Theme.Idle;
        public string VersionText = "";
        public string ClientsText = "";
        public string UptimeText = "";

        public HeaderBar()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Background;
            ForeColor = Theme.Text;
            Font = Theme.Body;
            Height = 64;
            TabStop = false;
        }

        public void SetValues(string game, string state, Color stateColor, string version, string clients, string uptime)
        {
            GameTitle = game == null ? "" : game;
            StateText = state == null ? "" : state;
            StateColor = stateColor;
            VersionText = version == null ? "" : version;
            ClientsText = clients == null ? "" : clients;
            UptimeText = uptime == null ? "" : uptime;
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Theme.Background);
            using (var pen = new Pen(Theme.Border, 1F))
            {
                e.Graphics.DrawLine(pen, 0, Height - 1, Width, Height - 1);
            }

            int center = Height / 2;
            using (var brush = new SolidBrush(StateColor))
            {
                e.Graphics.FillEllipse(brush, 20, center - 5, 10, 10);
            }

            int right = Width - 20;
            int gap = 18;
            int rightStart = right;
            if (UptimeText.Length > 0)
            {
                Size size = TextRenderer.MeasureText(UptimeText, Theme.Body);
                rightStart -= size.Width;
                TextRenderer.DrawText(e.Graphics, UptimeText, Theme.Body,
                    new Rectangle(rightStart, 0, size.Width, Height), Theme.Muted,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
                rightStart -= gap;
            }
            if (ClientsText.Length > 0)
            {
                Size size = TextRenderer.MeasureText(ClientsText, Theme.Body);
                rightStart -= size.Width;
                TextRenderer.DrawText(e.Graphics, ClientsText, Theme.Body,
                    new Rectangle(rightStart, 0, size.Width, Height), Theme.Muted,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
                rightStart -= gap;
            }
            if (VersionText.Length > 0)
            {
                Size size = TextRenderer.MeasureText(VersionText, Theme.Body);
                rightStart -= size.Width;
                TextRenderer.DrawText(e.Graphics, VersionText, Theme.Body,
                    new Rectangle(rightStart, 0, size.Width, Height), Theme.Muted,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
                rightStart -= gap;
            }

            int left = 42;
            int available = rightStart - left - 12;
            if (available < 80)
            {
                available = 80;
            }
            int titleWidth = (int)(available * 0.55F);
            if (titleWidth < 80)
            {
                titleWidth = 80;
            }
            if (titleWidth > available)
            {
                titleWidth = available;
            }
            TextRenderer.DrawText(e.Graphics, GameTitle, Theme.Title,
                new Rectangle(left, 0, titleWidth, Height), Theme.Text,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter
                    | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);

            int stateX = left + titleWidth + 14;
            int stateWidth = rightStart - stateX;
            if (stateWidth > 20)
            {
                TextRenderer.DrawText(e.Graphics, StateText, Theme.BodyBold,
                    new Rectangle(stateX, 0, stateWidth, Height), StateColor,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter
                        | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
            }
        }
    }

    /// <summary>A dark card: panel colour plus a one-pixel border.</summary>
    internal sealed class CardPanel : Panel
    {
        public CardPanel()
        {
            DoubleBuffered = true;
            BackColor = Theme.Panel;
            ForeColor = Theme.Text;
            Padding = new Padding(12);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            using (var pen = new Pen(Theme.Border, 1F))
            {
                e.Graphics.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
            }
        }
    }

    /// <summary>ListView with a hand-drawn dark header, alternating rows and no system colours.</summary>
    internal sealed class DarkListView : ListView
    {
        public DarkListView()
        {
            View = View.Details;
            FullRowSelect = true;
            HideSelection = false;
            MultiSelect = false;
            OwnerDraw = true;
            BorderStyle = BorderStyle.None;
            BackColor = Theme.Panel;
            ForeColor = Theme.Text;
            Font = Theme.Body;
            DoubleBuffered = true;
            SmallImageList = new ImageList();
            SmallImageList.ImageSize = new Size(1, 27);
            DrawColumnHeader += OnDrawColumnHeader;
            DrawItem += OnDrawItem;
            DrawSubItem += OnDrawSubItem;
        }

        private void OnDrawColumnHeader(object sender, DrawListViewColumnHeaderEventArgs e)
        {
            e.DrawDefault = false;
            using (var brush = new SolidBrush(Theme.Header))
            {
                e.Graphics.FillRectangle(brush, e.Bounds);
            }
            using (var pen = new Pen(Theme.Border, 1F))
            {
                e.Graphics.DrawLine(pen, e.Bounds.Left, e.Bounds.Bottom - 1,
                    e.Bounds.Right, e.Bounds.Bottom - 1);
                e.Graphics.DrawLine(pen, e.Bounds.Right - 1, e.Bounds.Top + 5,
                    e.Bounds.Right - 1, e.Bounds.Bottom - 6);
            }
            TextRenderer.DrawText(
                e.Graphics,
                e.Header.Text,
                Theme.Caption,
                new Rectangle(e.Bounds.X + 8, e.Bounds.Y, e.Bounds.Width - 14, e.Bounds.Height),
                Theme.Muted,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter
                    | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
        }

        private void OnDrawItem(object sender, DrawListViewItemEventArgs e)
        {
            e.DrawDefault = false;
            Color back = e.ItemIndex % 2 == 0 ? Theme.Panel : Theme.PanelAlt;
            if (e.Item.Selected)
            {
                back = Theme.Selection;
            }
            using (var brush = new SolidBrush(back))
            {
                e.Graphics.FillRectangle(brush, e.Bounds);
            }
        }

        private void OnDrawSubItem(object sender, DrawListViewSubItemEventArgs e)
        {
            e.DrawDefault = false;
            Color color = e.Item.Selected ? Theme.Text : e.Item.ForeColor;
            if (color.IsEmpty)
            {
                color = Theme.Text;
            }
            if (color == Color.Black || color == SystemColors.WindowText)
            {
                color = Theme.Text;
            }
            var rect = new Rectangle(e.Bounds.X + 6, e.Bounds.Y, e.Bounds.Width - 8, e.Bounds.Height);
            TextRenderer.DrawText(
                e.Graphics,
                e.SubItem.Text,
                Font,
                rect,
                color,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter
                    | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
        }
    }

    /// <summary>The window, the tray icon and the two-second refresh.</summary>
    internal sealed class MainForm : Form
    {
        private const int QueryTimeoutMs = 1500;
        private const int RefreshMs = 2000;
        private const int WalkMs = 250;

        private enum ViewMode
        {
            None,
            One,
            Multi,
        }

        private readonly GameInfo[] _games;
        private readonly string _deployDir;
        private readonly string _root;
        private readonly EventWaitHandle _showEvent;
        private readonly ManualResetEvent _stop = new ManualResetEvent(false);
        private readonly AutoResetEvent _walkWake = new AutoResetEvent(false);

        private readonly HeaderBar _topBar = new HeaderBar();
        private readonly TableLayoutPanel _middle = new TableLayoutPanel();
        private readonly Panel _content = new Panel();
        private readonly NavBar _nav = new NavBar();
        private readonly Panel _nonePanel = new Panel();
        private readonly CardPanel _noneCard = new CardPanel();
        private readonly DarkListView _list = new DarkListView();
        private readonly Label _emptyLabel = new Label();
        private readonly CardPanel _multiPanel = new CardPanel();
        private readonly Label _multiWarning = new Label();
        private readonly TableLayoutPanel _multiGrid = new TableLayoutPanel();
        private readonly List<Label> _multiInfos = new List<Label>();
        private readonly List<int> _multiIndices = new List<int>();
        private readonly Panel _pageHost = new Panel();
        private Panel[] _pages;
        private readonly WalkView _walkView = new WalkView();
        private readonly RichTextBox _logBox = new RichTextBox();
        private readonly DarkListView _keyList = new DarkListView();
        private readonly PictureBox _shotBox = new PictureBox();
        private readonly RichTextBox _stateBox = new RichTextBox();
        private readonly Panel _bottomBar = new Panel();
        private readonly Label _statusLabel = new Label();
        private readonly NotifyIcon _tray = new NotifyIcon();
        private readonly FlatButton _launchButton = new FlatButton();
        private readonly FlatButton _closeButton = new FlatButton();
        private readonly FlatButton _shotButton = new FlatButton();
        private readonly FlatButton _installButton = new FlatButton();

        private readonly Label _detailVersion = new Label();
        private readonly Label _detailPort = new Label();
        private readonly Label _detailClients = new Label();
        private readonly Label _detailHooks = new Label();
        private readonly Label _detailUptime = new Label();
        private readonly Label _detailLastKey = new Label();

        private readonly GameStatus[] _status;
        private readonly string[][] _logs;
        private readonly long[] _logStamps;
        private readonly string[] _shotFiles;
        private readonly string[] _keySignatures;
        private readonly string[] _stateSignatures;

        private readonly Dictionary<string, BaseMap> _mapCache = new Dictionary<string, BaseMap>();
        private readonly Dictionary<int, bool> _mapIsWorld = new Dictionary<int, bool>();

        private Thread _worker;
        private Thread _walkWorker;
        private RegisteredWaitHandle _showWait;
        private volatile bool _closing;
        private volatile bool _walkWanted;
        private volatile int _walkIndex = -1;
        private bool _exiting;
        private bool _balloonShown;
        private int _logOwner = -1;
        private long _logStamp = -2;
        private int _stateOwner = -1;
        private int _keyOwner = -1;
        private int _shotOwner = -1;
        private string _shotCurrent;
        private ViewMode _view = ViewMode.None;
        private int _runningIndex = -1;
        private int _mapGame = -1;
        private int _lastWalkSeq = -1;
        private int _shownWalkIndex = -1;
        private string _multiSignature = "";

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
                game.Installed = !string.IsNullOrEmpty(dirs[i]);
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
                _keySignatures[i] = "";
                _stateSignatures[i] = "";
            }

            Text = "FFPR 桥插件";
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(1080, 700);
            MinimumSize = new Size(820, 520);
            StartPosition = FormStartPosition.CenterScreen;
            Font = Theme.Body;
            ForeColor = Theme.Text;
            BackColor = Theme.Background;
            Icon = SystemIcons.Application;
            DoubleBuffered = true;

            BuildShell();
            BuildNonePanel();
            BuildMulti();
            BuildPages();
            BuildBottomBar();

            var root = new TableLayoutPanel();
            root.Dock = DockStyle.Fill;
            root.Margin = new Padding(0);
            root.BackColor = Theme.Background;
            root.ColumnCount = 1;
            root.RowCount = 3;
            root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 64F));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 58F));
            _topBar.Dock = DockStyle.Fill;
            _topBar.Margin = new Padding(0);
            _middle.Dock = DockStyle.Fill;
            _middle.Margin = new Padding(0);
            _bottomBar.Dock = DockStyle.Fill;
            _bottomBar.Margin = new Padding(0);
            root.Controls.Add(_topBar, 0, 0);
            root.Controls.Add(_middle, 0, 1);
            root.Controls.Add(_bottomBar, 0, 2);
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

            SetView(ViewMode.None);

            _showWait = ThreadPool.RegisterWaitForSingleObject(
                _showEvent,
                new WaitOrTimerCallback(OnShowSignal),
                null,
                Timeout.Infinite,
                false);
        }

        private void BuildShell()
        {
            _middle.Dock = DockStyle.Fill;
            _middle.Margin = new Padding(0);
            _middle.BackColor = Theme.Background;
            _middle.ColumnCount = 2;
            _middle.RowCount = 1;
            _middle.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 140F));
            _middle.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            _middle.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

            _nav.Dock = DockStyle.Fill;
            _nav.Margin = new Padding(0);
            _nav.SelectedIndexChanged += delegate(object sender, EventArgs args) { ShowPage(_nav.SelectedIndex); };

            _content.Dock = DockStyle.Fill;
            _content.Margin = new Padding(0);
            _content.BackColor = Theme.Background;

            _middle.Controls.Add(_nav, 0, 0);
            _middle.Controls.Add(_content, 1, 0);
        }

        private void BuildNonePanel()
        {
            _nonePanel.Dock = DockStyle.Fill;
            _nonePanel.Margin = new Padding(0);
            _nonePanel.Padding = new Padding(16);
            _nonePanel.BackColor = Theme.Background;

            _noneCard.Dock = DockStyle.Fill;
            _noneCard.Margin = new Padding(0);
            _noneCard.Padding = new Padding(14);
            _nonePanel.Controls.Add(_noneCard);

            var layout = new TableLayoutPanel();
            layout.Dock = DockStyle.Fill;
            layout.Margin = new Padding(0);
            layout.BackColor = Theme.Panel;
            layout.ColumnCount = 1;
            layout.RowCount = 3;
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 40F));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 38F));

            var title = new Label();
            title.Text = "作品";
            title.Dock = DockStyle.Fill;
            title.AutoSize = false;
            title.TextAlign = ContentAlignment.MiddleLeft;
            title.Font = Theme.Title;
            title.ForeColor = Theme.Text;
            title.BackColor = Color.Transparent;
            layout.Controls.Add(title, 0, 0);

            _list.Dock = DockStyle.Fill;
            _list.Margin = new Padding(0);
            _list.Columns.Add("作品", 480);
            _list.Columns.Add("装没装", 100);
            _list.Columns.Add("桥插件", 160);
            _list.SizeChanged += delegate(object sender, EventArgs args) { LayoutGameListColumns(); };
            for (int i = 0; i < _games.Length; i++)
            {
                var item = new ListViewItem(new string[] { _games[i].Title, "—", "—" });
                item.Tag = i;
                _list.Items.Add(item);
                UpdateRow(i);
            }
            layout.Controls.Add(_list, 0, 1);

            _emptyLabel.Dock = DockStyle.Fill;
            _emptyLabel.Margin = new Padding(0);
            _emptyLabel.AutoSize = false;
            _emptyLabel.TextAlign = ContentAlignment.MiddleCenter;
            _emptyLabel.ForeColor = Theme.Muted;
            _emptyLabel.Font = Theme.Body;
            _emptyLabel.BackColor = Color.Transparent;
            _emptyLabel.Text = "没有游戏在运行";
            layout.Controls.Add(_emptyLabel, 0, 2);

            _noneCard.Controls.Add(layout);
            _content.Controls.Add(_nonePanel);
        }

        private void LayoutGameListColumns()
        {
            if (_list.Columns.Count < 3)
            {
                return;
            }
            int width = _list.ClientSize.Width;
            if (width < 120)
            {
                width = 120;
            }
            int first = width * 56 / 100;
            int second = width * 16 / 100;
            int third = width - first - second - 24;
            if (third < 80)
            {
                third = 80;
            }
            _list.Columns[0].Width = first;
            _list.Columns[1].Width = second;
            _list.Columns[2].Width = third;
        }

        private void BuildMulti()
        {
            _multiPanel.Dock = DockStyle.Fill;
            _multiPanel.Margin = new Padding(0);
            _multiPanel.Padding = new Padding(14);
            _multiPanel.Visible = false;
            _content.Controls.Add(_multiPanel);

            var layout = new TableLayoutPanel();
            layout.Dock = DockStyle.Fill;
            layout.Margin = new Padding(0);
            layout.BackColor = Theme.Panel;
            layout.ColumnCount = 1;
            layout.RowCount = 2;
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 36F));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

            _multiWarning.Dock = DockStyle.Fill;
            _multiWarning.AutoSize = false;
            _multiWarning.TextAlign = ContentAlignment.MiddleLeft;
            _multiWarning.ForeColor = Theme.Error;
            _multiWarning.Font = Theme.Title;
            _multiWarning.BackColor = Color.Transparent;
            layout.Controls.Add(_multiWarning, 0, 0);

            _multiGrid.Dock = DockStyle.Fill;
            _multiGrid.Margin = new Padding(0);
            _multiGrid.BackColor = Theme.Panel;
            _multiGrid.AutoScroll = true;
            _multiGrid.ColumnCount = 3;
            _multiGrid.RowCount = 0;
            _multiGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 34F));
            _multiGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 56F));
            _multiGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110F));
            layout.Controls.Add(_multiGrid, 0, 1);

            _multiPanel.Controls.Add(layout);
        }

        private void BuildPages()
        {
            _pageHost.Dock = DockStyle.Fill;
            _pageHost.Margin = new Padding(0);
            _pageHost.Padding = new Padding(16);
            _pageHost.BackColor = Theme.Background;
            _pageHost.Visible = false;
            _content.Controls.Add(_pageHost);

            _pages = new Panel[5];
            _pages[0] = BuildWalkPage();
            _pages[1] = BuildShotPage();
            _pages[2] = BuildKeyPage();
            _pages[3] = BuildLogPage();
            _pages[4] = BuildStatePage();
            for (int i = 0; i < _pages.Length; i++)
            {
                _pages[i].Dock = DockStyle.Fill;
                _pages[i].Margin = new Padding(0);
                _pages[i].Visible = false;
                _pageHost.Controls.Add(_pages[i]);
            }
            ShowPage(0);
        }

        private Panel BuildWalkPage()
        {
            var page = new Panel();
            page.BackColor = Theme.Background;
            var card = new CardPanel();
            card.Dock = DockStyle.Fill;
            card.Margin = new Padding(0);
            card.Padding = new Padding(1);
            _walkView.Dock = DockStyle.Fill;
            _walkView.Margin = new Padding(0);
            card.Controls.Add(_walkView);
            page.Controls.Add(card);
            return page;
        }

        private Panel BuildShotPage()
        {
            var page = new Panel();
            page.BackColor = Theme.Background;
            var card = new CardPanel();
            card.Dock = DockStyle.Fill;
            card.Margin = new Padding(0);
            card.Padding = new Padding(10);
            _shotBox.Dock = DockStyle.Fill;
            _shotBox.Margin = new Padding(0);
            _shotBox.SizeMode = PictureBoxSizeMode.Zoom;
            _shotBox.BackColor = Theme.Background;
            card.Controls.Add(_shotBox);
            page.Controls.Add(card);
            return page;
        }

        private Panel BuildKeyPage()
        {
            var page = new Panel();
            page.BackColor = Theme.Background;
            var card = new CardPanel();
            card.Dock = DockStyle.Fill;
            card.Margin = new Padding(0);
            card.Padding = new Padding(10);
            _keyList.Dock = DockStyle.Fill;
            _keyList.Margin = new Padding(0);
            _keyList.Columns.Add("时间", 90);
            _keyList.Columns.Add("谁", 150);
            _keyList.Columns.Add("方式", 90);
            _keyList.Columns.Add("按键", 300);
            _keyList.Columns.Add("结果", 220);
            _keyList.SizeChanged += delegate(object sender, EventArgs args) { LayoutKeyColumns(); };
            card.Controls.Add(_keyList);
            page.Controls.Add(card);
            return page;
        }

        private void LayoutKeyColumns()
        {
            if (_keyList.Columns.Count < 5)
            {
                return;
            }
            int width = _keyList.ClientSize.Width;
            if (width < 260)
            {
                return;
            }
            int time = 80;
            int who = width * 21 / 100;
            if (who < 100)
            {
                who = 100;
            }
            int via = 80;
            int keys = width * 33 / 100;
            if (keys < 120)
            {
                keys = 120;
            }
            int result = width - time - who - via - keys - 24;
            if (result < 80)
            {
                result = 80;
            }
            _keyList.Columns[0].Width = time;
            _keyList.Columns[1].Width = who;
            _keyList.Columns[2].Width = via;
            _keyList.Columns[3].Width = keys;
            _keyList.Columns[4].Width = result;
        }

        private Panel BuildLogPage()
        {
            var page = new Panel();
            page.BackColor = Theme.Background;
            var card = new CardPanel();
            card.Dock = DockStyle.Fill;
            card.Margin = new Padding(0);
            card.Padding = new Padding(10);
            _logBox.Dock = DockStyle.Fill;
            _logBox.Margin = new Padding(0);
            _logBox.ReadOnly = true;
            _logBox.WordWrap = false;
            _logBox.ScrollBars = RichTextBoxScrollBars.Both;
            _logBox.Font = Theme.Mono;
            _logBox.BackColor = Theme.Panel;
            _logBox.ForeColor = Theme.Text;
            _logBox.BorderStyle = BorderStyle.None;
            _logBox.HideSelection = false;
            card.Controls.Add(_logBox);
            page.Controls.Add(card);
            return page;
        }

        private Panel BuildStatePage()
        {
            var page = new Panel();
            page.BackColor = Theme.Background;
            var layout = new TableLayoutPanel();
            layout.Dock = DockStyle.Fill;
            layout.Margin = new Padding(0);
            layout.BackColor = Theme.Background;
            layout.ColumnCount = 1;
            layout.RowCount = 2;
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 158F));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

            var stats = new TableLayoutPanel();
            stats.Dock = DockStyle.Fill;
            stats.Margin = new Padding(0);
            stats.BackColor = Theme.Background;
            stats.ColumnCount = 3;
            stats.RowCount = 2;
            stats.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 34F));
            stats.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33F));
            stats.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33F));
            stats.RowStyles.Add(new RowStyle(SizeType.Percent, 50F));
            stats.RowStyles.Add(new RowStyle(SizeType.Percent, 50F));
            AddStatCard(stats, "桥插件", _detailVersion, 0, 0);
            AddStatCard(stats, "端口", _detailPort, 1, 0);
            AddStatCard(stats, "连接", _detailClients, 2, 0);
            AddStatCard(stats, "挂钩", _detailHooks, 0, 1);
            AddStatCard(stats, "运行", _detailUptime, 1, 1);
            AddStatCard(stats, "最近按键", _detailLastKey, 2, 1);
            layout.Controls.Add(stats, 0, 0);

            var card = new CardPanel();
            card.Dock = DockStyle.Fill;
            card.Margin = new Padding(0);
            card.Padding = new Padding(10);
            _stateBox.Dock = DockStyle.Fill;
            _stateBox.Margin = new Padding(0);
            _stateBox.ReadOnly = true;
            _stateBox.WordWrap = false;
            _stateBox.ScrollBars = RichTextBoxScrollBars.Both;
            _stateBox.Font = Theme.Mono;
            _stateBox.BackColor = Theme.Panel;
            _stateBox.ForeColor = Theme.Text;
            _stateBox.BorderStyle = BorderStyle.None;
            _stateBox.HideSelection = false;
            card.Controls.Add(_stateBox);
            layout.Controls.Add(card, 0, 1);

            page.Controls.Add(layout);
            return page;
        }

        private static void AddStatCard(TableLayoutPanel grid, string title, Label value, int column, int row)
        {
            var card = new CardPanel();
            card.Dock = DockStyle.Fill;
            card.Margin = new Padding(0, 0, 8, 8);
            card.Padding = new Padding(10, 5, 10, 5);

            var caption = new Label();
            caption.Text = title;
            caption.Dock = DockStyle.Top;
            caption.Height = 20;
            caption.AutoSize = false;
            caption.TextAlign = ContentAlignment.MiddleLeft;
            caption.ForeColor = Theme.Muted;
            caption.Font = Theme.Small;
            caption.BackColor = Color.Transparent;

            value.Dock = DockStyle.Fill;
            value.AutoSize = false;
            value.TextAlign = ContentAlignment.MiddleLeft;
            value.AutoEllipsis = true;
            value.ForeColor = Theme.Text;
            value.Font = Theme.BodyBold;
            value.BackColor = Color.Transparent;
            value.Text = "—";

            card.Controls.Add(value);
            card.Controls.Add(caption);
            grid.Controls.Add(card, column, row);
        }

        private void BuildBottomBar()
        {
            _bottomBar.BackColor = Theme.Background;
            _bottomBar.Paint += delegate(object sender, PaintEventArgs e)
            {
                using (var pen = new Pen(Theme.Border, 1F))
                {
                    e.Graphics.DrawLine(pen, 0, 0, _bottomBar.Width, 0);
                }
            };

            _launchButton.Text = "启动";
            _launchButton.Margin = new Padding(0, 0, 8, 0);
            _launchButton.Click += new EventHandler(OnLaunch);

            _closeButton.Text = "关闭游戏";
            _closeButton.Danger = true;
            _closeButton.Margin = new Padding(0, 0, 8, 0);
            _closeButton.Click += new EventHandler(OnCloseGame);

            _shotButton.Text = "截图";
            _shotButton.Margin = new Padding(0, 0, 8, 0);
            _shotButton.Click += new EventHandler(OnShot);

            _installButton.Text = "安装桥插件";
            _installButton.Click += new EventHandler(OnInstall);

            var buttons = new FlowLayoutPanel();
            buttons.Dock = DockStyle.Fill;
            buttons.Margin = new Padding(0);
            buttons.AutoSize = true;
            buttons.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            buttons.FlowDirection = FlowDirection.LeftToRight;
            buttons.WrapContents = false;
            buttons.BackColor = Theme.Background;
            buttons.Padding = new Padding(16, 11, 0, 0);
            buttons.Controls.Add(_launchButton);
            buttons.Controls.Add(_closeButton);
            buttons.Controls.Add(_shotButton);
            buttons.Controls.Add(_installButton);

            _statusLabel.Dock = DockStyle.Fill;
            _statusLabel.Margin = new Padding(0);
            _statusLabel.AutoSize = false;
            _statusLabel.AutoEllipsis = true;
            _statusLabel.TextAlign = ContentAlignment.MiddleRight;
            _statusLabel.ForeColor = Theme.Muted;
            _statusLabel.Font = Theme.Small;
            _statusLabel.BackColor = Color.Transparent;
            _statusLabel.Padding = new Padding(0, 0, 18, 0);
            _statusLabel.Text = "就绪";

            var bar = new TableLayoutPanel();
            bar.Dock = DockStyle.Fill;
            bar.Margin = new Padding(0);
            bar.BackColor = Theme.Background;
            bar.ColumnCount = 2;
            bar.RowCount = 1;
            bar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            bar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            bar.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            bar.Controls.Add(buttons, 0, 0);
            bar.Controls.Add(_statusLabel, 1, 0);
            _bottomBar.Controls.Add(bar);
        }

        private void SetView(ViewMode mode)
        {
            _view = mode;
            bool one = mode == ViewMode.One;
            bool multi = mode == ViewMode.Multi;
            _middle.ColumnStyles[0].Width = one ? 140F : 0F;
            _nav.Visible = one;
            _pageHost.Visible = one;
            _nonePanel.Visible = mode == ViewMode.None;
            _multiPanel.Visible = multi;
            _launchButton.Visible = mode == ViewMode.None;
            _closeButton.Visible = one;
            _shotButton.Visible = one;
            _installButton.Visible = !multi;
            if (mode == ViewMode.None)
            {
                _emptyLabel.Text = "没有游戏在运行";
            }
            else if (multi)
            {
                _emptyLabel.Text = "同时开着多作，先关到只剩一作";
            }
            if (one)
            {
                ShowPage(_nav.SelectedIndex);
            }
            UpdateWalkWanted();
            UpdateHeader();
            PerformLayout();
        }

        private void ShowPage(int index)
        {
            if (_pages == null || _pages.Length == 0)
            {
                return;
            }
            if (index < 0 || index >= _pages.Length)
            {
                index = 0;
            }
            for (int i = 0; i < _pages.Length; i++)
            {
                _pages[i].Visible = i == index;
            }
            UpdateWalkWanted();
        }

        /// <summary>Ask the walk query only while its page is visible and the window is not minimised.</summary>
        private void UpdateWalkWanted()
        {
            bool wanted = _view == ViewMode.One
                && _runningIndex >= 0
                && _pageHost.Visible
                && _nav.SelectedIndex == 0
                && Visible
                && WindowState != FormWindowState.Minimized;
            _walkIndex = _runningIndex;
            _walkWanted = wanted;
            if (_closing)
            {
                return;
            }
            if (wanted)
            {
                _walkWake.Set();
            }
            else
            {
                _walkWake.Reset();
            }
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
            if (_walkWorker == null)
            {
                _walkWorker = new Thread(WalkLoop);
                _walkWorker.IsBackground = true;
                _walkWorker.Name = "FfprBridgeGui.Walk";
                _walkWorker.Start();
            }
            UpdateWalkWanted();
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            UpdateWalkWanted();
        }

        protected override void OnVisibleChanged(EventArgs e)
        {
            base.OnVisibleChanged(e);
            UpdateWalkWanted();
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
            _walkWanted = false;
            _walkWake.Set();
            if (_showWait != null)
            {
                _showWait.Unregister(null);
            }
            if (_worker != null)
            {
                _worker.Join(3000);
            }
            if (_walkWorker != null)
            {
                _walkWorker.Join(3000);
            }
            _tray.Visible = false;
            _tray.Dispose();
            _stop.Close();
            base.OnFormClosed(e);
        }

        private void HideToTray()
        {
            Hide();
            UpdateWalkWanted();
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
            UpdateWalkWanted();
        }

        private void OnTrayExit(object sender, EventArgs e)
        {
            _exiting = true;
            Close();
        }

        private int SelectedIndex()
        {
            if (_list.SelectedIndices.Count == 0)
            {
                return -1;
            }
            return _list.SelectedIndices[0];
        }

        private int CurrentIndex()
        {
            if (_view == ViewMode.One && _runningIndex >= 0)
            {
                return _runningIndex;
            }
            return SelectedIndex();
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

        private void UpdateHeader()
        {
            if (_view == ViewMode.None)
            {
                _topBar.SetValues("FFPR 桥插件", "没有游戏在运行", Theme.Idle, "", "", "");
                return;
            }
            if (_view == ViewMode.Multi)
            {
                int count = _multiIndices.Count;
                _topBar.SetValues("FFPR 桥插件", "同时开着 " + count.ToString(CultureInfo.InvariantCulture) + " 作",
                    Theme.Warning, "", "", "");
                return;
            }
            int index = _runningIndex;
            if (index < 0 || index >= _games.Length)
            {
                _topBar.SetValues("FFPR 桥插件", "没有游戏在运行", Theme.Idle, "", "", "");
                return;
            }
            var status = _status[index];
            var game = _games[index];
            string state = "运行中";
            Color color = Theme.Running;
            string version = "";
            string clients = "";
            string uptime = "";
            if (status == null || !status.Running)
            {
                state = "未运行";
                color = Theme.Idle;
            }
            else if (!status.Reachable)
            {
                state = "连不上";
                color = Theme.Warning;
                version = "桥插件 连不上";
            }
            else if (!status.HasBridge)
            {
                state = "旧版桥插件";
                color = Theme.Warning;
                version = "桥插件 旧版";
            }
            else
            {
                if (status.HookFailed.Count > 0 || HasRecentWarning(status))
                {
                    color = Theme.Error;
                }
                version = "桥插件 " + (string.IsNullOrEmpty(status.Version) ? "—" : status.Version);
                clients = "连接 " + status.ClientCount.ToString(CultureInfo.InvariantCulture);
                if (status.StartedAt != DateTime.MinValue)
                {
                    uptime = "运行 " + Clock(DateTime.UtcNow - status.StartedAt);
                }
            }
            _topBar.SetValues(game.Title, state, color, version, clients, uptime);
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
                        if (_games[i].Installed)
                        {
                            logs[i].Refresh(Path.Combine(_games[i].Dir, "BepInEx", "LogOutput.log"));
                        }
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
            status.Running = game.Installed && IsRunning(game.Process);
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

        private void Apply(GameStatus[] statuses, string[][] lines, long[] stamps)
        {
            var running = new List<int>();
            for (int i = 0; i < _games.Length; i++)
            {
                _status[i] = statuses[i];
                _logs[i] = lines[i];
                _logStamps[i] = stamps[i];
                UpdateRow(i);
                if (statuses[i].Running)
                {
                    running.Add(i);
                }
            }

            if (running.Count == 0)
            {
                _runningIndex = -1;
                if (_shownWalkIndex != -1)
                {
                    _shownWalkIndex = -1;
                    _walkView.Reset();
                }
                SetView(ViewMode.None);
                if (_list.Items.Count > 0 && _list.SelectedIndices.Count == 0)
                {
                    _list.Items[0].Selected = true;
                }
                _tray.Text = "FFPR 桥插件 · 没有游戏在运行";
            }
            else if (running.Count == 1)
            {
                int index = running[0];
                if (index != _shownWalkIndex)
                {
                    _shownWalkIndex = index;
                    _walkView.Reset();
                }
                _runningIndex = index;
                SetView(ViewMode.One);
                UpdateDetail(index);
                UpdateDetails(index);
                UpdateTrayText(index);
            }
            else
            {
                _runningIndex = -1;
                if (_shownWalkIndex != -1)
                {
                    _shownWalkIndex = -1;
                    _walkView.Reset();
                }
                UpdateMulti(running);
                SetView(ViewMode.Multi);
                _tray.Text = "FFPR 桥插件 · 同时开着 "
                    + running.Count.ToString(CultureInfo.InvariantCulture) + " 作";
            }
            UpdateHeader();
            UpdateWalkWanted();
        }

        private void UpdateRow(int index)
        {
            var item = _list.Items[index];
            var game = _games[index];
            item.SubItems[0].Text = game.Title;
            if (!game.Installed)
            {
                item.SubItems[1].Text = "没装";
                item.SubItems[2].Text = "—";
                item.ForeColor = Theme.Muted;
                return;
            }

            item.SubItems[1].Text = "已装";
            var version = InstalledBridgeVersion(game);
            item.SubItems[2].Text = version == null ? "没装" : version;
            item.ForeColor = Theme.Text;
        }

        /// <summary>The version copied into BepInEx/plugins/FfprBridge, or null when it is absent.</summary>
        private static string InstalledBridgeVersion(GameInfo game)
        {
            if (!game.Installed)
            {
                return null;
            }
            var dir = Path.Combine(game.Dir, "BepInEx", "plugins", "FfprBridge");
            try
            {
                var file = Path.Combine(dir, "version.txt");
                if (File.Exists(file))
                {
                    var text = File.ReadAllText(file, Encoding.UTF8).Trim();
                    if (text.Length > 0)
                    {
                        return text;
                    }
                }
                if (File.Exists(dir + ".dll"))
                {
                    return "旧版";
                }
                if (Directory.Exists(dir))
                {
                    return "未知";
                }
            }
            catch (Exception)
            {
                // A locked or unreadable plugin folder must not break the refresh.
            }
            return null;
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

        private void UpdateDetail(int index)
        {
            var status = _status[index];
            bool hot = status != null && (status.HookFailed.Count > 0 || HasRecentWarning(status));
            if (status == null)
            {
                _detailVersion.Text = "—";
                _detailPort.Text = "—";
                _detailClients.Text = "—";
                _detailHooks.Text = "—";
                _detailUptime.Text = "—";
                _detailLastKey.Text = "—";
                _detailVersion.ForeColor = Theme.Text;
                _detailHooks.ForeColor = Theme.Text;
                return;
            }

            if (!status.Reachable)
            {
                _detailVersion.Text = "连不上";
                _detailVersion.ForeColor = Theme.Warning;
            }
            else if (status.HasBridge)
            {
                _detailVersion.Text = string.IsNullOrEmpty(status.Version) ? "—" : status.Version;
                _detailVersion.ForeColor = hot ? Theme.Error : Theme.Text;
            }
            else
            {
                _detailVersion.Text = "旧版";
                _detailVersion.ForeColor = Theme.Warning;
            }
            _detailPort.Text = status.Port.ToString(CultureInfo.InvariantCulture);
            if (status.ClientCount == 0)
            {
                _detailClients.Text = "0 个";
            }
            else
            {
                _detailClients.Text = status.ClientCount.ToString(CultureInfo.InvariantCulture)
                    + " 个(" + status.ClientAddresses + ")";
            }
            int total = status.HookOk.Count + status.HookFailed.Count;
            if (status.HookFailed.Count > 0)
            {
                _detailHooks.Text = status.HookOk.Count.ToString(CultureInfo.InvariantCulture)
                    + "/" + total.ToString(CultureInfo.InvariantCulture) + " 有失败";
                _detailHooks.ForeColor = Theme.Error;
            }
            else
            {
                _detailHooks.Text = status.HookOk.Count.ToString(CultureInfo.InvariantCulture)
                    + "/" + total.ToString(CultureInfo.InvariantCulture);
                _detailHooks.ForeColor = hot ? Theme.Warning : Theme.Text;
            }
            _detailUptime.Text = status.HasBridge && status.StartedAt != DateTime.MinValue
                ? Duration(DateTime.UtcNow - status.StartedAt)
                : "—";
            _detailLastKey.Text = LastKeyText(status);
        }

        private static string LastKeyText(GameStatus status)
        {
            if (status == null || status.Keys.Count == 0)
            {
                return "—";
            }
            var last = status.Keys[status.Keys.Count - 1];
            var who = string.IsNullOrEmpty(last.Sender) ? AddressOf(last.Remote) : last.Sender;
            return Ago(last.At) + (who.Length == 0 ? "" : " · " + who);
        }

        private void UpdateMulti(List<int> running)
        {
            var signature = new StringBuilder();
            for (int i = 0; i < running.Count; i++)
            {
                if (i > 0)
                {
                    signature.Append(',');
                }
                signature.Append(running[i].ToString(CultureInfo.InvariantCulture));
            }
            var text = signature.ToString();
            if (!string.Equals(text, _multiSignature, StringComparison.Ordinal))
            {
                BuildMultiRows(running);
                _multiSignature = text;
            }
            for (int i = 0; i < _multiIndices.Count; i++)
            {
                _multiInfos[i].Text = MultiInfo(_status[_multiIndices[i]]);
            }

            var names = new StringBuilder();
            for (int i = 0; i < running.Count; i++)
            {
                if (i > 0)
                {
                    names.Append('、');
                }
                names.Append(_games[running[i]].Key.ToUpperInvariant());
            }
            _multiWarning.Text = "同时开着 " + names.ToString() + "，一次只开一作";
        }

        private void BuildMultiRows(List<int> running)
        {
            _multiGrid.SuspendLayout();
            while (_multiGrid.Controls.Count > 0)
            {
                var control = _multiGrid.Controls[0];
                _multiGrid.Controls.RemoveAt(0);
                control.Dispose();
            }
            _multiGrid.RowStyles.Clear();
            _multiGrid.RowCount = running.Count;
            _multiInfos.Clear();
            _multiIndices.Clear();

            for (int i = 0; i < running.Count; i++)
            {
                int index = running[i];
                _multiGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 42F));

                var title = new Label();
                title.Text = _games[index].Title;
                title.Dock = DockStyle.Fill;
                title.AutoSize = false;
                title.TextAlign = ContentAlignment.MiddleLeft;
                title.AutoEllipsis = true;
                title.ForeColor = Theme.Text;
                title.Font = Theme.BodyBold;
                title.BackColor = Color.Transparent;
                title.Margin = new Padding(0, 2, 4, 2);

                var info = new Label();
                info.Dock = DockStyle.Fill;
                info.AutoSize = false;
                info.TextAlign = ContentAlignment.MiddleLeft;
                info.AutoEllipsis = true;
                info.ForeColor = Theme.Muted;
                info.Font = Theme.Small;
                info.BackColor = Color.Transparent;
                info.Margin = new Padding(0, 2, 4, 2);

                var close = new FlatButton();
                close.Text = "关闭游戏";
                close.Danger = true;
                close.AutoSize = false;
                close.Dock = DockStyle.Fill;
                close.Font = Theme.Small;
                close.Margin = new Padding(4, 4, 0, 4);
                close.Tag = index;
                close.Click += new EventHandler(OnCloseRunning);

                _multiGrid.Controls.Add(title, 0, i);
                _multiGrid.Controls.Add(info, 1, i);
                _multiGrid.Controls.Add(close, 2, i);
                _multiInfos.Add(info);
                _multiIndices.Add(index);
            }
            _multiGrid.ResumeLayout();
        }

        private static string MultiInfo(GameStatus status)
        {
            if (status == null)
            {
                return "";
            }
            string version;
            if (!status.Reachable)
            {
                version = "连不上";
            }
            else if (status.HasBridge)
            {
                version = string.IsNullOrEmpty(status.Version) ? "—" : status.Version;
            }
            else
            {
                version = "旧版";
            }
            return "运行中 · 桥插件 " + version + " · 端口 "
                + status.Port.ToString(CultureInfo.InvariantCulture);
        }

        private void UpdateTrayText(int index)
        {
            var status = _status[index];
            if (status == null || !status.Running)
            {
                _tray.Text = "FFPR 桥插件 · 没有游戏在运行";
                return;
            }
            string state = status.Reachable ? "连着" : "连不上";
            _tray.Text = "FFPR 桥插件 · " + _games[index].Key.ToUpperInvariant() + " · " + state;
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
                    Color color = Theme.Text;
                    if (line.IndexOf("[Warning", StringComparison.Ordinal) >= 0)
                    {
                        color = Theme.Warning;
                    }
                    else if (line.IndexOf("[Error", StringComparison.Ordinal) >= 0
                        || line.IndexOf("[Fatal", StringComparison.Ordinal) >= 0)
                    {
                        color = Theme.Error;
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
                    item.ForeColor = key.Ok ? Theme.Text : Theme.Error;
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
                AppendLine(_stateBox, "这一作没开。", Theme.Muted);
                return;
            }
            if (!status.Reachable)
            {
                AppendLine(_stateBox, "连不上桥插件（端口 " + status.Port.ToString(CultureInfo.InvariantCulture) + "）。", Theme.Muted);
                return;
            }
            if (!status.HasBridge)
            {
                AppendLine(_stateBox, "这一作装的是旧版桥插件，没有 bridge 查询。", Theme.Warning);
                AppendLine(_stateBox, "装 0.14.0 以后这里会显示详情。", Theme.Warning);
                return;
            }

            AppendLine(_stateBox, "桥插件", Theme.Text);
            AppendLine(_stateBox, "  版本：" + status.Version, Theme.Text);
            AppendLine(_stateBox, "  作品：" + status.BridgeGame, Theme.Text);
            AppendLine(_stateBox, "  进程：" + status.Process, Theme.Text);
            var started = status.StartedAt == DateTime.MinValue
                ? "—"
                : status.StartedAt.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
            AppendLine(_stateBox, "  启动：" + started, Theme.Text);
            AppendLine(_stateBox, "  端口：" + status.Port.ToString(CultureInfo.InvariantCulture), Theme.Text);
            AppendLine(_stateBox, "  运行："
                + (status.StartedAt == DateTime.MinValue ? "—" : Duration(DateTime.UtcNow - status.StartedAt)), Theme.Text);
            AppendLine(_stateBox, "", Theme.Text);

            AppendLine(_stateBox, "挂钩（" + status.HookOk.Count.ToString(CultureInfo.InvariantCulture)
                + " 成功，" + status.HookFailed.Count.ToString(CultureInfo.InvariantCulture) + " 失败）", Theme.Text);
            if (status.HookOk.Count > 0)
            {
                AppendLine(_stateBox, "  成功：" + string.Join("、", status.HookOk.ToArray()), Theme.Text);
            }
            if (status.HookFailed.Count == 0)
            {
                AppendLine(_stateBox, "  失败：无", Theme.Text);
            }
            else
            {
                foreach (var failure in status.HookFailed)
                {
                    AppendLine(_stateBox, "  失败：" + failure.Name + "  " + failure.Error, Theme.Error);
                }
            }
            AppendLine(_stateBox, "", Theme.Text);

            AppendLine(_stateBox, "客户端（" + status.ClientCount.ToString(CultureInfo.InvariantCulture) + "）", Theme.Text);
            if (status.ClientCount == 0)
            {
                AppendLine(_stateBox, "  没有连接", Theme.Text);
            }
            else
            {
                foreach (var client in status.Clients)
                {
                    AppendLine(_stateBox, "  " + client.Remote + "  " + ChannelName(client.Channel)
                        + "  " + client.Since.ToLocalTime().ToString("HH:mm:ss", CultureInfo.InvariantCulture), Theme.Text);
                }
            }
            AppendLine(_stateBox, "", Theme.Text);

            AppendLine(_stateBox, "警告（最近 " + status.Warnings.Count.ToString(CultureInfo.InvariantCulture) + " 条）", Theme.Text);
            if (status.Warnings.Count == 0)
            {
                AppendLine(_stateBox, "  没有", Theme.Text);
            }
            else
            {
                foreach (var warning in status.Warnings)
                {
                    Color color = warning.Level == "Warning" ? Theme.Warning : Theme.Error;
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
            if (_view != ViewMode.None)
            {
                return;
            }
            int index = SelectedIndex();
            if (index < 0)
            {
                SetStatus("先在列表里选一作");
                return;
            }
            var game = _games[index];
            SetStatus("正在启动 " + game.Title + " …");
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
            int index = CurrentIndex();
            if (index < 0)
            {
                SetStatus("先在列表里选一作");
                return;
            }
            CloseGameAt(index);
        }

        private void OnCloseRunning(object sender, EventArgs e)
        {
            var button = sender as Control;
            if (button == null)
            {
                return;
            }
            object tag = button.Tag;
            if (!(tag is int))
            {
                return;
            }
            CloseGameAt((int)tag);
        }

        private void CloseGameAt(int index)
        {
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
            int index = CurrentIndex();
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
                        _nav.SelectedIndex = 1;
                        ShowPage(1);
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
            var script = Path.Combine(_deployDir, "install-bridge.ps1");
            var games = new StringBuilder();
            bool any = false;
            for (int i = 0; i < _games.Length; i++)
            {
                if (!_games[i].Installed)
                {
                    continue;
                }
                if (any)
                {
                    games.Append(',');
                }
                games.Append(_games[i].Key);
                any = true;
            }
            if (!any)
            {
                SetStatus("六作都还没装");
                return;
            }
            _installButton.Enabled = false;
            SetStatus("正在安装桥插件 …");
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
                dialog.ClientSize = new Size(720, 460);
                dialog.MinimizeBox = false;
                dialog.MaximizeBox = false;
                dialog.ShowInTaskbar = false;
                dialog.BackColor = Theme.Background;
                dialog.ForeColor = Theme.Text;
                dialog.Font = Theme.Body;

                var body = new Panel();
                body.Dock = DockStyle.Fill;
                body.Padding = new Padding(14);
                body.BackColor = Theme.Background;

                var box = new TextBox();
                box.Multiline = true;
                box.ReadOnly = true;
                box.ScrollBars = ScrollBars.Both;
                box.WordWrap = false;
                box.Dock = DockStyle.Fill;
                box.Font = Theme.Mono;
                box.BackColor = Theme.Panel;
                box.ForeColor = Theme.Text;
                box.BorderStyle = BorderStyle.None;
                box.Text = text;
                body.Controls.Add(box);

                var footer = new FlowLayoutPanel();
                footer.Dock = DockStyle.Bottom;
                footer.Height = 56;
                footer.FlowDirection = FlowDirection.RightToLeft;
                footer.WrapContents = false;
                footer.BackColor = Theme.Background;
                footer.Padding = new Padding(14, 10, 14, 10);

                var close = new FlatButton();
                close.Text = "关闭";
                close.AutoSize = false;
                close.Size = new Size(96, 34);
                close.Click += delegate(object sender, EventArgs args)
                {
                    dialog.DialogResult = DialogResult.OK;
                    dialog.Close();
                };
                footer.Controls.Add(close);

                dialog.Controls.Add(body);
                dialog.Controls.Add(footer);
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

        private static string Clock(TimeSpan span)
        {
            if (span < TimeSpan.Zero)
            {
                span = TimeSpan.Zero;
            }
            int hours = (int)span.TotalHours;
            if (hours > 0)
            {
                return hours.ToString(CultureInfo.InvariantCulture)
                    + ":" + span.Minutes.ToString("00", CultureInfo.InvariantCulture)
                    + ":" + span.Seconds.ToString("00", CultureInfo.InvariantCulture);
            }
            return span.Minutes.ToString("00", CultureInfo.InvariantCulture)
                + ":" + span.Seconds.ToString("00", CultureInfo.InvariantCulture);
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

        // ---- walk page -------------------------------------------------------------------

        private void WalkLoop()
        {
            var client = new BridgeClient();
            var mapClient = new BridgeClient();
            try
            {
                while (!_closing)
                {
                    if (!_walkWanted)
                    {
                        _walkWake.WaitOne(500);
                        continue;
                    }
                    int index = _walkIndex;
                    if (index < 0 || index >= _games.Length)
                    {
                        _walkWake.WaitOne(WalkMs);
                        continue;
                    }
                    if (index != _mapGame)
                    {
                        _mapGame = index;
                        _mapCache.Clear();
                        _mapIsWorld.Clear();
                    }
                    var game = _games[index];
                    var reply = client.Query(game.Port, "walk", QueryTimeoutMs);
                    string message;
                    WalkData data = WalkParse.FromReply(reply, out message);
                    if (data != null)
                    {
                        if (data.Seq < _lastWalkSeq)
                        {
                            _mapCache.Clear();
                            _mapIsWorld.Clear();
                        }
                        _lastWalkSeq = data.Seq;
                    }
                    BaseMap map = null;
                    if (data != null && _walkWanted)
                    {
                        map = EnsureMap(mapClient, index, game.Port, data);
                    }
                    if (_closing)
                    {
                        break;
                    }
                    WalkData postedData = data;
                    string postedMessage = message;
                    BaseMap postedMap = map;
                    int postedIndex = index;
                    Post(delegate() { ApplyWalk(postedIndex, postedData, postedMessage, postedMap); });
                    _walkWake.WaitOne(WalkMs);
                }
            }
            finally
            {
                client.Dispose();
                mapClient.Dispose();
            }
        }

        private void ApplyWalk(int index, WalkData data, string message, BaseMap map)
        {
            if (index != _runningIndex || !_walkWanted)
            {
                return;
            }
            _walkView.SetWalk(data, message, map);
        }

        private BaseMap EnsureMap(BridgeClient client, int gameIndex, int port, WalkData data)
        {
            if (!_walkWanted || _closing)
            {
                return null;
            }
            string baseKey = gameIndex.ToString(CultureInfo.InvariantCulture)
                + ":" + data.Map.ToString(CultureInfo.InvariantCulture);
            bool world;
            if (_mapIsWorld.TryGetValue(data.Map, out world))
            {
                if (world)
                {
                    return LoadWorldMap(client, gameIndex, port, data);
                }
                BaseMap cached;
                if (_mapCache.TryGetValue(baseKey, out cached))
                {
                    return cached;
                }
            }

            var reply = client.Query(port, "collision", QueryTimeoutMs);
            BaseMap interior = BaseMap.ParseCollision(reply);
            if (interior != null)
            {
                _mapIsWorld[data.Map] = false;
                CacheMap(baseKey, interior);
                return interior;
            }
            _mapIsWorld[data.Map] = true;
            return LoadWorldMap(client, gameIndex, port, data);
        }

        private BaseMap LoadWorldMap(BridgeClient client, int gameIndex, int port, WalkData data)
        {
            int minX;
            int minY;
            int maxX;
            int maxY;
            if (!WalkGeometry.CellBounds(data, 3, out minX, out minY, out maxX, out maxY))
            {
                return null;
            }
            string key = gameIndex.ToString(CultureInfo.InvariantCulture)
                + ":w:" + data.Map.ToString(CultureInfo.InvariantCulture)
                + ":" + minX.ToString(CultureInfo.InvariantCulture)
                + "," + minY.ToString(CultureInfo.InvariantCulture)
                + "," + maxX.ToString(CultureInfo.InvariantCulture)
                + "," + maxY.ToString(CultureInfo.InvariantCulture);
            BaseMap cached;
            if (_mapCache.TryGetValue(key, out cached))
            {
                return cached;
            }

            int width = maxX - minX + 1;
            int height = maxY - minY + 1;
            int columns = width <= 49 ? 1 : 2;
            int rows = height <= 49 ? 1 : 2;
            BaseMap composite = null;
            bool complete = true;
            for (int row = 0; row < rows; row++)
            {
                int wy0 = minY + height * row / rows;
                int wy1 = minY + height * (row + 1) / rows - 1;
                for (int column = 0; column < columns; column++)
                {
                    if (!_walkWanted || _closing)
                    {
                        complete = false;
                        break;
                    }
                    int wx0 = minX + width * column / columns;
                    int wx1 = minX + width * (column + 1) / columns - 1;
                    int cx = (wx0 + wx1) / 2;
                    int cy = (wy0 + wy1) / 2;
                    int radius = Math.Max(6, Math.Max((wx1 - wx0 + 1) / 2 + 2, (wy1 - wy0 + 1) / 2 + 2));
                    if (radius > 24)
                    {
                        radius = 24;
                    }
                    var fields = "\"at\":[" + cx.ToString(CultureInfo.InvariantCulture)
                        + "," + cy.ToString(CultureInfo.InvariantCulture)
                        + "],\"r\":" + radius.ToString(CultureInfo.InvariantCulture);
                    var reply = client.Query(port, "cells", fields, QueryTimeoutMs);
                    BaseMap part = BaseMap.ParseCells(reply, cx - radius, cy - radius);
                    if (part == null)
                    {
                        continue;
                    }
                    if (composite == null)
                    {
                        composite = part;
                    }
                    else
                    {
                        composite.Merge(part);
                    }
                }
            }
            if (composite != null && complete)
            {
                CacheMap(key, composite);
            }
            return composite;
        }

        private void CacheMap(string key, BaseMap map)
        {
            if (_mapCache.Count > 32)
            {
                _mapCache.Clear();
            }
            _mapCache[key] = map;
        }
    }

    internal sealed class WalkData
    {
        public int Seq;
        public bool Active;
        public int Map;
        public readonly List<Point> Path = new List<Point>();
        public bool HasGoal;
        public Point Goal;
        public string Label;
        public int Index;
        public int Steps;
        public bool HasCell;
        public Point Cell;
        public WalkSegment Segment;
        public readonly List<WalkTurn> Turns = new List<WalkTurn>();
        public DateTime StartedAt;
        public DateTime EndedAt;
        public string Reason;
    }

    internal sealed class WalkSegment
    {
        public int N;
        public int Of;
        public bool HasFrom;
        public Point From;
        public bool HasTo;
        public Point To;
    }

    internal sealed class WalkTurn
    {
        public bool HasCell;
        public Point Cell;
        public double AtX;
        public double AtY;
        public long Frame;
        public bool Ok;
    }

    internal static class WalkParse
    {
        public static WalkData FromReply(Dictionary<string, object> reply, out string message)
        {
            message = null;
            if (reply == null)
            {
                message = "连不上桥插件";
                return null;
            }
            if (!Json.Bool(Json.Field(reply, "ok"), true))
            {
                message = "桥插件不支持 walk 查询（需要 0.14.0）";
                return null;
            }
            object raw;
            if (!reply.TryGetValue("walk", out raw))
            {
                message = "桥插件没有返回走路数据";
                return null;
            }
            if (raw == null)
            {
                message = "现在没有在走路";
                return null;
            }
            var walk = Json.Map(raw);
            if (walk == null)
            {
                message = "walk 回复的格式不对";
                return null;
            }

            var data = new WalkData();
            data.Seq = Json.Int(Json.Field(walk, "seq"), 0);
            data.Active = Json.Bool(Json.Field(walk, "active"), false);
            data.Map = Json.Int(Json.Field(walk, "map"), 0);
            data.Label = Json.Text(walk, "label");
            data.Index = Json.Int(Json.Field(walk, "index"), 0);
            data.Steps = Json.Int(Json.Field(walk, "steps"), 0);
            data.StartedAt = Json.Time(Json.Text(walk, "startedAt"));
            data.EndedAt = Json.Time(Json.Text(walk, "endedAt"));
            data.Reason = Json.Text(walk, "reason");

            var path = Json.Array(Json.Field(walk, "path"));
            if (path != null)
            {
                foreach (var item in path)
                {
                    Point point;
                    if (Json.TryPoint(item, out point))
                    {
                        data.Path.Add(point);
                    }
                }
            }

            Point goal;
            if (Json.TryPoint(Json.Field(walk, "goal"), out goal))
            {
                data.HasGoal = true;
                data.Goal = goal;
            }
            Point cell;
            if (Json.TryPoint(Json.Field(walk, "cell"), out cell))
            {
                data.HasCell = true;
                data.Cell = cell;
            }

            var segment = Json.Map(Json.Field(walk, "segment"));
            if (segment != null)
            {
                var parsed = new WalkSegment();
                parsed.N = Json.Int(Json.Field(segment, "n"), 0);
                parsed.Of = Json.Int(Json.Field(segment, "of"), 0);
                Point from;
                if (Json.TryPoint(Json.Field(segment, "from"), out from))
                {
                    parsed.HasFrom = true;
                    parsed.From = from;
                }
                Point to;
                if (Json.TryPoint(Json.Field(segment, "to"), out to))
                {
                    parsed.HasTo = true;
                    parsed.To = to;
                }
                data.Segment = parsed;
            }

            var turns = Json.Array(Json.Field(walk, "turns"));
            if (turns != null)
            {
                foreach (var item in turns)
                {
                    var map = Json.Map(item);
                    if (map == null)
                    {
                        continue;
                    }
                    var turn = new WalkTurn();
                    Point turnCell;
                    if (Json.TryPoint(Json.Field(map, "cell"), out turnCell))
                    {
                        turn.HasCell = true;
                        turn.Cell = turnCell;
                    }
                    var atArray = Json.Array(Json.Field(map, "at"));
                    if (atArray != null && atArray.Length >= 2)
                    {
                        turn.AtX = Json.Double(atArray[0], 0D);
                        turn.AtY = Json.Double(atArray[1], 0D);
                    }
                    else
                    {
                        Point at;
                        if (Json.TryPoint(Json.Field(map, "at"), out at))
                        {
                            turn.AtX = at.X;
                            turn.AtY = at.Y;
                        }
                    }
                    turn.Frame = Json.Long(Json.Field(map, "frame"), 0);
                    turn.Ok = Json.Bool(Json.Field(map, "ok"), false);
                    data.Turns.Add(turn);
                }
            }
            return data;
        }
    }

    /// <summary>Pure geometry used by the walk view; no control is needed to test it.</summary>
    internal static class WalkGeometry
    {
        public static bool CellBounds(WalkData data, int pad, out int minX, out int minY, out int maxX, out int maxY)
        {
            bool any = false;
            minX = 0;
            minY = 0;
            maxX = 0;
            maxY = 0;
            if (data == null)
            {
                return false;
            }
            foreach (var point in data.Path)
            {
                Add(point.X, point.Y, ref any, ref minX, ref minY, ref maxX, ref maxY);
            }
            if (data.HasGoal)
            {
                Add(data.Goal.X, data.Goal.Y, ref any, ref minX, ref minY, ref maxX, ref maxY);
            }
            if (data.HasCell)
            {
                Add(data.Cell.X, data.Cell.Y, ref any, ref minX, ref minY, ref maxX, ref maxY);
            }
            if (data.Segment != null)
            {
                if (data.Segment.HasFrom)
                {
                    Add(data.Segment.From.X, data.Segment.From.Y, ref any, ref minX, ref minY, ref maxX, ref maxY);
                }
                if (data.Segment.HasTo)
                {
                    Add(data.Segment.To.X, data.Segment.To.Y, ref any, ref minX, ref minY, ref maxX, ref maxY);
                }
            }
            if (!any)
            {
                return false;
            }
            minX -= pad;
            minY -= pad;
            maxX += pad;
            maxY += pad;
            return true;
        }

        private static void Add(int x, int y, ref bool any, ref int minX, ref int minY, ref int maxX, ref int maxY)
        {
            if (!any)
            {
                any = true;
                minX = x;
                minY = y;
                maxX = x;
                maxY = y;
                return;
            }
            if (x < minX)
            {
                minX = x;
            }
            if (x > maxX)
            {
                maxX = x;
            }
            if (y < minY)
            {
                minY = y;
            }
            if (y > maxY)
            {
                maxY = y;
            }
        }

        public static void Fit(
            RectangleF area,
            int minX,
            int minY,
            int maxX,
            int maxY,
            out float cell,
            out float offsetX,
            out float offsetY)
        {
            float width = maxX - minX + 1;
            float height = maxY - minY + 1;
            if (width < 1F)
            {
                width = 1F;
            }
            if (height < 1F)
            {
                height = 1F;
            }
            cell = Math.Min(area.Width / width, area.Height / height);
            if (cell <= 0F)
            {
                cell = 1F;
            }
            offsetX = area.X + (area.Width - width * cell) / 2F - minX * cell;
            offsetY = area.Y + (area.Height - height * cell) / 2F - minY * cell;
        }
    }

    internal static class WalkText
    {
        public static string ReasonText(string reason)
        {
            if (string.IsNullOrEmpty(reason))
            {
                return "停着";
            }
            string lower = reason.ToLowerInvariant();
            switch (lower)
            {
                case "arrived":
                    return "到达";
                case "battle":
                    return "遇敌";
                case "dialog":
                    return "对话";
                case "map_changed":
                    return "换图";
                case "blocked":
                    return "被挡住";
                case "off_path":
                    return "偏离路线";
                case "timeout":
                    return "超时";
                case "stopped":
                    return "停止";
                case "closed":
                    return "连接断开";
                case "bad_path":
                    return "路线无效";
                case "no_player":
                    return "读不到人物";
            }
            if (lower.StartsWith("state:", StringComparison.Ordinal))
            {
                string state = reason.Substring(6);
                if (string.Equals(state, "Event", StringComparison.OrdinalIgnoreCase))
                {
                    return "剧情";
                }
                return "其他状态：" + state;
            }
            return reason;
        }

        public static string Clock(TimeSpan span)
        {
            if (span < TimeSpan.Zero)
            {
                span = TimeSpan.Zero;
            }
            int hours = (int)span.TotalHours;
            if (hours > 0)
            {
                return hours.ToString(CultureInfo.InvariantCulture)
                    + ":" + span.Minutes.ToString("00", CultureInfo.InvariantCulture)
                    + ":" + span.Seconds.ToString("00", CultureInfo.InvariantCulture);
            }
            return span.Minutes.ToString("00", CultureInfo.InvariantCulture)
                + ":" + span.Seconds.ToString("00", CultureInfo.InvariantCulture);
        }

        public static Color ReasonColor(string reason, bool active)
        {
            if (active)
            {
                return Theme.Running;
            }
            if (string.IsNullOrEmpty(reason))
            {
                return Theme.Muted;
            }
            string lower = reason.ToLowerInvariant();
            if (lower == "arrived")
            {
                return Theme.Running;
            }
            if (lower == "battle" || lower == "dialog" || lower == "map_changed"
                || lower == "stopped" || lower.StartsWith("state:", StringComparison.Ordinal))
            {
                return Theme.Warning;
            }
            return Theme.Error;
        }
    }

    /// <summary>The hand-drawn walk page: base map, three route styles, markers and an info column.</summary>
    internal sealed class WalkView : Control
    {
        private WalkData _data;
        private string _message;
        private BaseMap _map;

        public WalkView()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Panel;
            ForeColor = Theme.Text;
            Font = Theme.Body;
        }

        public void SetWalk(WalkData data, string message, BaseMap map)
        {
            _data = data;
            _message = message;
            _map = map;
            Invalidate();
        }

        public void Reset()
        {
            _data = null;
            _message = null;
            _map = null;
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(Theme.Panel);
            if (_data == null)
            {
                DrawEmpty(e.Graphics);
                return;
            }
            int infoWidth = Width / 5;
            if (infoWidth < 200)
            {
                infoWidth = 200;
            }
            if (infoWidth > 300)
            {
                infoWidth = 300;
            }
            if (infoWidth > Width - 100)
            {
                infoWidth = Math.Max(100, Width - 100);
            }
            int legendHeight = Height >= 160 ? 28 : 0;
            var mapRect = new Rectangle(0, 0, Width - infoWidth, Height - legendHeight);
            var legendRect = new Rectangle(0, mapRect.Bottom, Width - infoWidth, legendHeight);
            var infoRect = new Rectangle(Width - infoWidth, 0, infoWidth, Height);
            DrawMap(e.Graphics, mapRect);
            if (legendHeight > 0)
            {
                DrawLegend(e.Graphics, legendRect);
            }
            using (var pen = new Pen(Theme.Border, 1F))
            {
                e.Graphics.DrawLine(pen, infoRect.X, 0, infoRect.X, Height);
            }
            DrawInfo(e.Graphics, infoRect);
        }

        private void DrawLegend(Graphics graphics, Rectangle rect)
        {
            using (var brush = new SolidBrush(Theme.Panel))
            {
                graphics.FillRectangle(brush, rect);
            }
            using (var pen = new Pen(Theme.Border, 1F))
            {
                graphics.DrawLine(pen, rect.Left, rect.Top, rect.Right, rect.Top);
            }
            int y = rect.Top + rect.Height / 2;
            int x = rect.Left + 12;
            using (var pen = new Pen(Theme.Muted, 1.6F))
            {
                pen.DashStyle = DashStyle.Dot;
                pen.DashCap = DashCap.Round;
                graphics.DrawLine(pen, x, y, x + 18, y);
            }
            x += 24;
            x = DrawLegendText(graphics, "走过", x, y);
            x += 10;
            using (var pen = new Pen(Theme.Accent, 3F))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                graphics.DrawLine(pen, x, y, x + 18, y);
            }
            x += 24;
            x = DrawLegendText(graphics, "正在走的段", x, y);
            x += 10;
            using (var pen = new Pen(Theme.AccentSoft, 2F))
            {
                pen.DashStyle = DashStyle.Dash;
                graphics.DrawLine(pen, x, y, x + 18, y);
            }
            x += 24;
            x = DrawLegendText(graphics, "还没走", x, y);
            x += 10;
            using (var brush = new SolidBrush(Theme.Text))
            {
                graphics.FillEllipse(brush, x + 6, y - 4, 8, 8);
            }
            x = DrawLegendText(graphics, "人", x + 18, y);
            x += 10;
            using (var pen = new Pen(Theme.Warning, 2F))
            {
                graphics.DrawEllipse(pen, x + 6, y - 4, 8, 8);
            }
            DrawLegendText(graphics, "目标", x + 18, y);
        }

        private static int DrawLegendText(Graphics graphics, string text, int x, int y)
        {
            Size size = TextRenderer.MeasureText(text, Theme.Small);
            TextRenderer.DrawText(graphics, text, Theme.Small,
                new Rectangle(x, y - size.Height / 2, size.Width, size.Height), Theme.Muted,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine
                    | TextFormatFlags.NoPrefix);
            return x + size.Width;
        }

        private void DrawEmpty(Graphics graphics)
        {
            string text = _message;
            if (string.IsNullOrEmpty(text))
            {
                text = "还没有走路数据";
            }
            var rect = new Rectangle(24, 24, Math.Max(20, Width - 48), Math.Max(20, Height - 48));
            TextRenderer.DrawText(
                graphics,
                text,
                Theme.Body,
                rect,
                Theme.Muted,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter
                    | TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix);
        }

        private void DrawMap(Graphics graphics, Rectangle rect)
        {
            graphics.SetClip(rect);
            using (var brush = new SolidBrush(Theme.Background))
            {
                graphics.FillRectangle(brush, rect);
            }
            int minX;
            int minY;
            int maxX;
            int maxY;
            if (!WalkGeometry.CellBounds(_data, 3, out minX, out minY, out maxX, out maxY))
            {
                graphics.ResetClip();
                return;
            }
            var area = new RectangleF(rect.X + 16, rect.Y + 16, rect.Width - 32, rect.Height - 32);
            if (area.Width < 4F || area.Height < 4F)
            {
                area = new RectangleF(rect.X + 2, rect.Y + 2, Math.Max(1, rect.Width - 4), Math.Max(1, rect.Height - 4));
            }
            float cell;
            float offsetX;
            float offsetY;
            WalkGeometry.Fit(area, minX, minY, maxX, maxY, out cell, out offsetX, out offsetY);

            int vx0 = (int)Math.Floor((rect.Left - offsetX) / cell);
            int vx1 = (int)Math.Ceiling((rect.Right - offsetX) / cell);
            int vy0 = (int)Math.Floor((rect.Top - offsetY) / cell);
            int vy1 = (int)Math.Ceiling((rect.Bottom - offsetY) / cell);

            if (_map != null)
            {
                DrawBaseMap(graphics, cell, offsetX, offsetY, vx0, vx1, vy0, vy1);
            }
            if (cell >= 8F && _map != null)
            {
                using (var pen = new Pen(Theme.MapGrid, 1F))
                {
                    for (int x = vx0; x <= vx1; x++)
                    {
                        float px = offsetX + x * cell;
                        graphics.DrawLine(pen, px, rect.Top, px, rect.Bottom);
                    }
                    for (int y = vy0; y <= vy1; y++)
                    {
                        float py = offsetY + y * cell;
                        graphics.DrawLine(pen, rect.Left, py, rect.Right, py);
                    }
                }
            }
            DrawRoute(graphics, cell, offsetX, offsetY);
            graphics.ResetClip();
        }

        private void DrawBaseMap(
            Graphics graphics,
            float cell,
            float offsetX,
            float offsetY,
            int vx0,
            int vx1,
            int vy0,
            int vy1)
        {
            if (_map.Kind == MapKind.Interior)
            {
                using (var floor = new SolidBrush(Theme.MapFloor))
                using (var walk = new SolidBrush(Theme.MapWalk))
                using (var wall = new SolidBrush(Theme.MapWall))
                {
                    for (int y = Math.Max(0, vy0); y <= Math.Min(_map.Rows.Count - 1, vy1); y++)
                    {
                        string row = _map.Rows[y];
                        if (row == null)
                        {
                            continue;
                        }
                        for (int x = Math.Max(0, vx0); x <= Math.Min(row.Length - 1, vx1); x++)
                        {
                            char ch = row[x];
                            Brush brush = wall;
                            if (ch == '0')
                            {
                                brush = floor;
                            }
                            else if (ch == '2' || ch == '3' || ch == '4' || ch == '5')
                            {
                                brush = walk;
                            }
                            graphics.FillRectangle(brush, offsetX + x * cell, offsetY + y * cell,
                                cell + 0.5F, cell + 0.5F);
                        }
                    }
                }
                return;
            }
            if (_map.Kind == MapKind.World)
            {
                int mapMinX = _map.OriginX;
                int mapMinY = _map.OriginY;
                int mapMaxX = mapMinX + _map.WorldWidth - 1;
                int mapMaxY = mapMinY + _map.WorldHeight - 1;
                using (var sea = new SolidBrush(Theme.MapSea))
                using (var mountain = new SolidBrush(Theme.MapMountain))
                using (var grass = new SolidBrush(Theme.MapGrass))
                using (var land = new SolidBrush(Theme.MapLand))
                {
                    for (int y = Math.Max(mapMinY, vy0); y <= Math.Min(mapMaxY, vy1); y++)
                    {
                        for (int x = Math.Max(mapMinX, vx0); x <= Math.Min(mapMaxX, vx1); x++)
                        {
                            int attr = _map.WorldAttr(x, y);
                            if (attr < 0)
                            {
                                continue;
                            }
                            Brush brush = land;
                            if (attr == 16)
                            {
                                brush = sea;
                            }
                            else if (attr == 19 || attr == 27)
                            {
                                brush = mountain;
                            }
                            else if (attr == 3 || attr == 4)
                            {
                                brush = grass;
                            }
                            graphics.FillRectangle(brush, offsetX + x * cell, offsetY + y * cell,
                                cell + 0.5F, cell + 0.5F);
                        }
                    }
                }
            }
        }

        private void DrawRoute(Graphics graphics, float cell, float offsetX, float offsetY)
        {
            var data = _data;
            if (data.Path.Count == 0 && !data.HasGoal)
            {
                return;
            }

            int walked = data.Steps;
            if (walked <= 0)
            {
                walked = data.Index;
            }
            if (walked < 0)
            {
                walked = 0;
            }
            if (walked >= data.Path.Count)
            {
                walked = Math.Max(0, data.Path.Count - 1);
            }
            int toIndex = -1;
            bool hasSegment = data.Segment != null && data.Segment.HasFrom && data.Segment.HasTo;
            if (hasSegment)
            {
                toIndex = IndexOf(data.Path, data.Segment.To);
            }

            if (data.Path.Count > 1)
            {
                int from = hasSegment && toIndex >= 0 ? toIndex : walked;
                if (from < data.Path.Count - 1)
                {
                    using (var pen = new Pen(Theme.AccentSoft, 2F))
                    {
                        pen.DashStyle = DashStyle.Dash;
                        pen.StartCap = LineCap.Round;
                        pen.EndCap = LineCap.Round;
                        DrawPath(graphics, pen, data.Path, from, data.Path.Count - 1, cell, offsetX, offsetY);
                    }
                }
            }
            if (walked > 0)
            {
                using (var pen = new Pen(Theme.Muted, 1.6F))
                {
                    pen.DashStyle = DashStyle.Dot;
                    pen.DashCap = DashCap.Round;
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    DrawPath(graphics, pen, data.Path, 0, walked, cell, offsetX, offsetY);
                }
            }
            if (hasSegment)
            {
                using (var pen = new Pen(Theme.Accent, Math.Min(8F, Math.Max(3F, cell * 0.2F))))
                {
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    pen.LineJoin = LineJoin.Round;
                    graphics.DrawLine(pen,
                        Center(data.Segment.From, cell, offsetX, offsetY),
                        Center(data.Segment.To, cell, offsetX, offsetY));
                }
            }

            if (data.HasGoal && data.Path.Count > 0)
            {
                var last = data.Path[data.Path.Count - 1];
                if (last.X != data.Goal.X || last.Y != data.Goal.Y)
                {
                    using (var pen = new Pen(Theme.MutedFaint, 1.4F))
                    {
                        pen.DashStyle = DashStyle.Dash;
                        graphics.DrawLine(pen,
                            Center(last, cell, offsetX, offsetY),
                            Center(data.Goal, cell, offsetX, offsetY));
                    }
                }
            }

            foreach (var turn in data.Turns)
            {
                Point point;
                if (turn.HasCell)
                {
                    point = turn.Cell;
                }
                else
                {
                    point = new Point((int)Math.Round(turn.AtX), (int)Math.Round(turn.AtY));
                }
                float cx = offsetX + (point.X + 0.5F) * cell;
                float cy = offsetY + (point.Y + 0.5F) * cell;
                float radius = Math.Min(6F, Math.Max(2F, cell * 0.1F));
                if (turn.Ok)
                {
                    using (var brush = new SolidBrush(Theme.Muted))
                    {
                        graphics.FillEllipse(brush, cx - radius, cy - radius, radius * 2F, radius * 2F);
                    }
                }
                else
                {
                    using (var pen = new Pen(Theme.Warning, 2F))
                    {
                        graphics.DrawLine(pen, cx - radius, cy - radius, cx + radius, cy + radius);
                        graphics.DrawLine(pen, cx + radius, cy - radius, cx - radius, cy + radius);
                    }
                }
            }

            if (data.HasGoal)
            {
                float cx = offsetX + (data.Goal.X + 0.5F) * cell;
                float cy = offsetY + (data.Goal.Y + 0.5F) * cell;
                float radius = Math.Min(14F, Math.Max(4F, cell * 0.33F));
                using (var pen = new Pen(Theme.Warning, 2.4F))
                {
                    graphics.DrawEllipse(pen, cx - radius, cy - radius, radius * 2F, radius * 2F);
                }
            }

            if (data.HasCell || data.Path.Count > 0)
            {
                Point person = data.HasCell ? data.Cell : data.Path[walked];
                float cx = offsetX + (person.X + 0.5F) * cell;
                float cy = offsetY + (person.Y + 0.5F) * cell;
                float radius = Math.Min(12F, Math.Max(3F, cell * 0.3F));
                using (var brush = new SolidBrush(Theme.Text))
                {
                    graphics.FillEllipse(brush, cx - radius, cy - radius, radius * 2F, radius * 2F);
                }
                using (var pen = new Pen(Theme.Background, 1.4F))
                {
                    graphics.DrawEllipse(pen, cx - radius, cy - radius, radius * 2F, radius * 2F);
                }
            }
        }

        private static void DrawPath(
            Graphics graphics,
            Pen pen,
            List<Point> path,
            int start,
            int end,
            float cell,
            float offsetX,
            float offsetY)
        {
            for (int i = start; i < end; i++)
            {
                if (i < 0 || i + 1 >= path.Count)
                {
                    break;
                }
                graphics.DrawLine(pen,
                    Center(path[i], cell, offsetX, offsetY),
                    Center(path[i + 1], cell, offsetX, offsetY));
            }
        }

        private static PointF Center(Point point, float cell, float offsetX, float offsetY)
        {
            return new PointF(offsetX + (point.X + 0.5F) * cell, offsetY + (point.Y + 0.5F) * cell);
        }

        private static int IndexOf(List<Point> path, Point point)
        {
            for (int i = 0; i < path.Count; i++)
            {
                if (path[i].X == point.X && path[i].Y == point.Y)
                {
                    return i;
                }
            }
            return -1;
        }

        private void DrawInfo(Graphics graphics, Rectangle rect)
        {
            int x = rect.X + 16;
            int y = rect.Y + 14;
            int width = rect.Width - 30;
            if (width < 40)
            {
                return;
            }
            graphics.SetClip(rect);
            y += DrawText(graphics, "走路", Theme.Small, Theme.Muted, x, y, width) + 3;
            string label = _data.Label;
            if (string.IsNullOrEmpty(label))
            {
                label = "没有说明";
            }
            y += DrawText(graphics, label, Theme.Title, Theme.Text, x, y, width) + 4;
            y += DrawText(graphics, "地图 " + _data.Map.ToString(CultureInfo.InvariantCulture),
                Theme.Body, Theme.Muted, x, y, width) + 2;
            if (_data.HasGoal)
            {
                y += DrawText(graphics, "目标 (" + _data.Goal.X.ToString(CultureInfo.InvariantCulture)
                    + "," + _data.Goal.Y.ToString(CultureInfo.InvariantCulture) + ")",
                    Theme.MonoSmall, Theme.Muted, x, y, width) + 2;
            }
            y += 6;

            using (var pen = new Pen(Theme.Border, 1F))
            {
                graphics.DrawLine(pen, x, y, x + width, y);
            }
            y += 10;

            var segment = _data.Segment;
            if (segment != null && segment.Of > 0)
            {
                y += DrawText(graphics, "第 " + segment.N.ToString(CultureInfo.InvariantCulture)
                    + "/" + segment.Of.ToString(CultureInfo.InvariantCulture) + " 段",
                    Theme.BodyBold, Theme.Text, x, y, width) + 2;
                if (segment.HasFrom && segment.HasTo)
                {
                    y += DrawText(graphics, "(" + segment.From.X.ToString(CultureInfo.InvariantCulture)
                        + "," + segment.From.Y.ToString(CultureInfo.InvariantCulture) + ") → ("
                        + segment.To.X.ToString(CultureInfo.InvariantCulture) + ","
                        + segment.To.Y.ToString(CultureInfo.InvariantCulture) + ")",
                        Theme.Mono, Theme.Text, x, y, width) + 4;
                }
            }
            else
            {
                y += DrawText(graphics, "当前没有分段", Theme.Body, Theme.Muted, x, y, width) + 4;
            }

            int walked = _data.Steps;
            if (walked <= 0)
            {
                walked = _data.Index;
            }
            if (walked < 0)
            {
                walked = 0;
            }
            int total = _data.Path.Count > 0 ? _data.Path.Count - 1 : walked;
            if (total < walked)
            {
                total = walked;
            }
            y += DrawText(graphics, "已走 " + walked.ToString(CultureInfo.InvariantCulture)
                + "/" + total.ToString(CultureInfo.InvariantCulture) + " 格",
                Theme.Body, Theme.Text, x, y, width) + 2;

            int turnsOk = 0;
            foreach (var turn in _data.Turns)
            {
                if (turn.Ok)
                {
                    turnsOk++;
                }
            }
            y += DrawText(graphics, "拐角 " + _data.Turns.Count.ToString(CultureInfo.InvariantCulture)
                + " 个 · 不停 " + turnsOk.ToString(CultureInfo.InvariantCulture),
                Theme.Body, Theme.Text, x, y, width) + 2;

            TimeSpan elapsed = TimeSpan.Zero;
            if (_data.StartedAt != DateTime.MinValue)
            {
                DateTime end = _data.EndedAt != DateTime.MinValue ? _data.EndedAt : DateTime.UtcNow;
                elapsed = end - _data.StartedAt;
                if (elapsed < TimeSpan.Zero)
                {
                    elapsed = TimeSpan.Zero;
                }
            }
            double perCell = walked > 0 ? elapsed.TotalSeconds / walked : 0D;
            y += DrawText(graphics, "用时 " + WalkText.Clock(elapsed) + " · "
                + perCell.ToString("0.00", CultureInfo.InvariantCulture) + " 秒/格",
                Theme.MonoSmall, Theme.Muted, x, y, width) + 8;

            string status = _data.Active ? "正在走" : WalkText.ReasonText(_data.Reason);
            y += DrawText(graphics, "状态", Theme.Small, Theme.Muted, x, y, width) + 2;
            y += DrawText(graphics, status, Theme.BodyBold,
                WalkText.ReasonColor(_data.Reason, _data.Active), x, y, width);
            graphics.ResetClip();
        }

        private static int DrawText(Graphics graphics, string text, Font font, Color color, int x, int y, int width)
        {
            if (text == null)
            {
                text = "";
            }
            var flags = TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix;
            Size size = TextRenderer.MeasureText(graphics, text, font, new Size(width, int.MaxValue), flags);
            if (size.Height < 1)
            {
                size.Height = font.Height;
            }
            TextRenderer.DrawText(graphics, text, font, new Rectangle(x, y, width, size.Height), color, flags);
            return size.Height;
        }
    }

    internal enum MapKind
    {
        None,
        Interior,
        World,
    }

    /// <summary>A cached collision layer or a stitched world-cell window.</summary>
    internal sealed class BaseMap
    {
        public MapKind Kind;
        public int Layer;
        public readonly List<string> Rows = new List<string>();
        public int OriginX;
        public int OriginY;
        public int WorldWidth;
        public int WorldHeight;
        public int[] World;

        public int WorldAttr(int x, int y)
        {
            if (World == null || x < OriginX || y < OriginY)
            {
                return -1;
            }
            int column = x - OriginX;
            int row = y - OriginY;
            if (column < 0 || row < 0 || column >= WorldWidth || row >= WorldHeight)
            {
                return -1;
            }
            return World[row * WorldWidth + column];
        }

        public static BaseMap ParseCollision(Dictionary<string, object> reply)
        {
            if (reply == null || !Json.Bool(Json.Field(reply, "ok"), true))
            {
                return null;
            }
            object collisionObject = Json.Field(reply, "collision");
            if (collisionObject == null)
            {
                collisionObject = reply;
            }
            var collision = Json.Map(collisionObject);
            object layersObject = collision != null ? Json.Field(collision, "layers") : collisionObject;
            var layers = Json.Array(layersObject);
            if (layers == null || layers.Length == 0)
            {
                return null;
            }
            int search = 0;
            if (collision != null)
            {
                search = Json.Int(Json.Field(collision, "searchLayer"), 0);
            }
            if (search < 0 || search >= layers.Length)
            {
                search = 0;
            }
            object layerObject = layers[search];
            var layer = Json.Map(layerObject);
            object rowsObject = layer != null ? Json.Field(layer, "rows") : layerObject;
            var rows = Json.Array(rowsObject);
            if (rows == null || rows.Length == 0)
            {
                return null;
            }
            var map = new BaseMap();
            map.Kind = MapKind.Interior;
            map.Layer = search;
            foreach (var item in rows)
            {
                string row = Json.Str(item);
                map.Rows.Add(row == null ? "" : row);
            }
            return map;
        }

        public static BaseMap ParseCells(Dictionary<string, object> reply, int fallbackX, int fallbackY)
        {
            if (reply == null || !Json.Bool(Json.Field(reply, "ok"), true))
            {
                return null;
            }
            object cellsObject = Json.Field(reply, "cells");
            var cells = Json.Map(cellsObject);
            if (cells == null)
            {
                var direct = Json.Array(cellsObject);
                if (direct == null)
                {
                    return null;
                }
                cells = new Dictionary<string, object>();
                cells["attr"] = direct;
                cells["origin"] = Json.Field(reply, "origin");
            }
            int originX = fallbackX;
            int originY = fallbackY;
            Point origin;
            if (Json.TryPoint(Json.Field(cells, "origin"), out origin)
                || Json.TryPoint(Json.Field(reply, "origin"), out origin))
            {
                originX = origin.X;
                originY = origin.Y;
            }
            else
            {
                originX = Json.Int(Json.Field(cells, "originX"), Json.Int(Json.Field(cells, "x"), originX));
                originY = Json.Int(Json.Field(cells, "originY"), Json.Int(Json.Field(cells, "y"), originY));
            }

            object attrObject = Json.Field(cells, "attr");
            if (attrObject == null)
            {
                attrObject = Json.Field(cells, "attrs");
            }
            if (attrObject == null)
            {
                attrObject = Json.Field(cells, "data");
            }
            if (attrObject == null)
            {
                attrObject = Json.Field(cells, "terrain");
            }
            if (attrObject == null)
            {
                attrObject = Json.Field(cells, "rows");
            }
            var attr = Json.Array(attrObject);
            if (attr == null || attr.Length == 0)
            {
                return null;
            }

            int declaredWidth = Json.Int(Json.Field(cells, "w"), 0);
            if (declaredWidth <= 0)
            {
                declaredWidth = Json.Int(Json.Field(cells, "width"), 0);
            }
            if (declaredWidth <= 0)
            {
                declaredWidth = Json.Int(Json.Field(cells, "cols"), 0);
            }
            int declaredHeight = Json.Int(Json.Field(cells, "h"), 0);
            if (declaredHeight <= 0)
            {
                declaredHeight = Json.Int(Json.Field(cells, "height"), 0);
            }
            if (declaredHeight <= 0)
            {
                declaredHeight = Json.Int(Json.Field(cells, "rows"), 0);
            }

            var values = new List<int[]>();
            var firstRow = Json.Array(attr[0]);
            if (firstRow != null)
            {
                foreach (var item in attr)
                {
                    var rowArray = Json.Array(item);
                    if (rowArray == null)
                    {
                        values.Add(new int[] { Json.Int(item, -1) });
                        continue;
                    }
                    var row = new int[rowArray.Length];
                    for (int i = 0; i < rowArray.Length; i++)
                    {
                        row[i] = Json.Int(rowArray[i], -1);
                    }
                    values.Add(row);
                }
            }
            else
            {
                int width = declaredWidth;
                if (width <= 0)
                {
                    int radius = Json.Int(Json.Field(cells, "r"), 0);
                    if (radius > 0)
                    {
                        width = radius * 2 + 1;
                    }
                    else
                    {
                        int side = (int)Math.Sqrt(attr.Length);
                        width = side > 0 && side * side == attr.Length ? side : attr.Length;
                    }
                }
                if (width <= 0)
                {
                    width = 1;
                }
                int height = declaredHeight;
                if (height <= 0)
                {
                    height = (attr.Length + width - 1) / width;
                }
                for (int y = 0; y < height; y++)
                {
                    var row = new int[width];
                    for (int x = 0; x < width; x++)
                    {
                        int index = y * width + x;
                        row[x] = index < attr.Length ? Json.Int(attr[index], -1) : -1;
                    }
                    values.Add(row);
                }
            }

            int mapWidth = 0;
            foreach (var row in values)
            {
                if (row.Length > mapWidth)
                {
                    mapWidth = row.Length;
                }
            }
            if (declaredWidth > mapWidth)
            {
                mapWidth = declaredWidth;
            }
            if (mapWidth <= 0)
            {
                return null;
            }
            if (declaredHeight > 0 && values.Count > declaredHeight)
            {
                values.RemoveRange(declaredHeight, values.Count - declaredHeight);
            }
            int mapHeight = declaredHeight > values.Count ? declaredHeight : values.Count;

            var map = new BaseMap();
            map.Kind = MapKind.World;
            map.OriginX = originX;
            map.OriginY = originY;
            map.WorldWidth = mapWidth;
            map.WorldHeight = mapHeight;
            map.World = new int[mapWidth * mapHeight];
            for (int i = 0; i < map.World.Length; i++)
            {
                map.World[i] = -1;
            }
            for (int y = 0; y < values.Count; y++)
            {
                for (int x = 0; x < mapWidth; x++)
                {
                    map.World[y * mapWidth + x] = x < values[y].Length ? values[y][x] : -1;
                }
            }
            return map;
        }

        public void Merge(BaseMap other)
        {
            if (other == null || other.Kind != MapKind.World || other.World == null
                || other.WorldWidth <= 0 || other.WorldHeight <= 0)
            {
                return;
            }
            if (Kind != MapKind.World || World == null)
            {
                Kind = MapKind.World;
                OriginX = other.OriginX;
                OriginY = other.OriginY;
                WorldWidth = other.WorldWidth;
                WorldHeight = other.WorldHeight;
                World = new int[WorldWidth * WorldHeight];
                for (int i = 0; i < World.Length; i++)
                {
                    World[i] = -1;
                }
                CopyFrom(other);
                return;
            }

            int minX = Math.Min(OriginX, other.OriginX);
            int minY = Math.Min(OriginY, other.OriginY);
            int maxX = Math.Max(OriginX + WorldWidth, other.OriginX + other.WorldWidth);
            int maxY = Math.Max(OriginY + WorldHeight, other.OriginY + other.WorldHeight);
            int width = maxX - minX;
            int height = maxY - minY;
            var merged = new int[width * height];
            for (int i = 0; i < merged.Length; i++)
            {
                merged[i] = -1;
            }
            var old = new BaseMap();
            old.Kind = MapKind.World;
            old.OriginX = OriginX;
            old.OriginY = OriginY;
            old.WorldWidth = WorldWidth;
            old.WorldHeight = WorldHeight;
            old.World = World;
            OriginX = minX;
            OriginY = minY;
            WorldWidth = width;
            WorldHeight = height;
            World = merged;
            CopyFrom(old);
            CopyFrom(other);
        }

        private void CopyFrom(BaseMap source)
        {
            for (int y = 0; y < source.WorldHeight; y++)
            {
                for (int x = 0; x < source.WorldWidth; x++)
                {
                    int value = source.World[y * source.WorldWidth + x];
                    if (value < 0)
                    {
                        continue;
                    }
                    int targetX = source.OriginX + x - OriginX;
                    int targetY = source.OriginY + y - OriginY;
                    if (targetX < 0 || targetY < 0 || targetX >= WorldWidth || targetY >= WorldHeight)
                    {
                        continue;
                    }
                    World[targetY * WorldWidth + targetX] = value;
                }
            }
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
            return Query(port, op, null, timeoutMs);
        }

        public Dictionary<string, object> Query(int port, string op, string fields, int timeoutMs)
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
                            + ",\"op\":\"" + op + "\""
                            + (fields == null || fields.Length == 0 ? "" : "," + fields)
                            + "}";
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
        public bool Installed;
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

        public static long Long(object value, long fallback)
        {
            if (value == null)
            {
                return fallback;
            }
            try
            {
                return Convert.ToInt64(value, CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                return fallback;
            }
        }

        public static double Double(object value, double fallback)
        {
            if (value == null)
            {
                return fallback;
            }
            try
            {
                return Convert.ToDouble(value, CultureInfo.InvariantCulture);
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

        public static bool TryPoint(object value, out Point point)
        {
            point = Point.Empty;
            var array = value as object[];
            if (array != null && array.Length >= 2)
            {
                point = new Point(Int(array[0], 0), Int(array[1], 0));
                return true;
            }
            var map = value as Dictionary<string, object>;
            if (map != null)
            {
                object x = Field(map, "x");
                object y = Field(map, "y");
                if (x != null && y != null)
                {
                    point = new Point(Int(x, 0), Int(y, 0));
                    return true;
                }
            }
            return false;
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
