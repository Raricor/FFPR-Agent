using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;

namespace FfprBridge;

/// <summary>
/// Presses keys for the agent from inside the game process (control plan §4.1; allowed since
/// 0.5.0). The keys go through SendInput like a person's keyboard: nothing in the game's memory
/// is written. Every key waits until the game's own window is in front, so keys never land in
/// another window or on the lock screen. Commands run one at a time on their own thread, never
/// on the game thread; "stop" cancels the running one and everything queued behind it.
///
///   {"id": 1, "op": "keys", "keys": ["Down*3", "Enter", "Up:600"], "gap": 120}
///   {"id": 2, "op": "status"}
///   {"id": 3, "op": "stop"}
/// </summary>
internal static class Keyboard
{
    private const int MaxHoldMs = 5000;
    private const int MaxTimes = 50;
    private const int DefaultHoldMs = 70;
    private const int DefaultGapMs = 120;

    private static readonly BlockingCollection<(WebSocket From, JsonObject Command)> Queue = new(64);
    private static readonly Regex Spec = new(@"^(?<name>[A-Za-z0-9]+)(:(?<hold>\d+))?(\*(?<times>\d+))?$");
    private static readonly int OwnPid = Environment.ProcessId;
    private static volatile bool _stop;

    // Virtual-key code and whether it is an extended key (needs the E0 prefix); the same names
    // as deploy/laptop/pilot-agent.ps1.
    private static readonly Dictionary<string, (ushort Vk, bool Extended)> Codes = BuildCodes();

    public static void Start()
    {
        new Thread(Loop) { IsBackground = true, Name = "FfprBridge.Keyboard" }.Start();
    }

    /// <summary>Called on a socket thread with one command message.</summary>
    public static void Enqueue(WebSocket from, string text)
    {
        JsonObject command;
        try
        {
            command = JsonNode.Parse(text)?.AsObject() ?? throw new FormatException("空命令");
        }
        catch (Exception e)
        {
            Reply(from, null, Failed(e.Message));
            return;
        }
        if (command["op"]?.GetValue<string>() == "stop")
        {
            _stop = true;
            GameInput.ReleaseAll();
            while (Queue.TryTake(out var queued))
            {
                Reply(queued.From, queued.Command, Failed("stopped"));
            }
            Reply(from, command, new JsonObject { ["ok"] = true });
            return;
        }
        if (!Queue.TryAdd((from, command)))
        {
            Reply(from, command, Failed("busy"));
        }
    }

    private static void Loop()
    {
        foreach (var (from, command) in Queue.GetConsumingEnumerable())
        {
            _stop = false;
            JsonObject result;
            try
            {
                result = command["op"]?.GetValue<string>() switch
                {
                    "keys" => Keys(command),
                    "hold" => Hold(command),
                    "status" => Status(),
                    var op => Failed($"未知的 op:{op}"),
                };
            }
            catch (Exception e)
            {
                result = Failed($"{e.GetType().Name}: {e.Message}");
            }
            Reply(from, command, result);
        }
    }

    private static JsonObject Keys(JsonObject command)
    {
        var gap = Math.Clamp(command["gap"]?.GetValue<int>() ?? DefaultGapMs, 0, MaxHoldMs);
        var specs = command["keys"]?.AsArray() ?? throw new ArgumentException("keys 需要按键列表");
        // "via": "game" presses a virtual gamepad inside the game and needs no focus (GameInput).
        var inGame = command["via"]?.GetValue<string>() == "game";
        var sent = 0;
        foreach (var node in specs)
        {
            var spec = node?.GetValue<string>() ?? "";
            var m = Spec.Match(spec);
            if (!m.Success)
            {
                return Failed($"bad_key:{spec}", sent);
            }
            if (!Codes.TryGetValue(m.Groups["name"].Value, out var code))
            {
                return Failed($"unknown_key:{m.Groups["name"].Value}", sent);
            }
            var name = m.Groups["name"].Value;
            if (inGame && !GameInput.Knows(name))
            {
                return Failed($"no_game_button:{name}", sent);
            }
            var hold = m.Groups["hold"].Success ? Math.Min(int.Parse(m.Groups["hold"].Value), MaxHoldMs) : DefaultHoldMs;
            var times = m.Groups["times"].Success ? Math.Min(int.Parse(m.Groups["times"].Value), MaxTimes) : 1;
            for (var i = 0; i < times; i++)
            {
                if (_stop)
                {
                    return Failed("stopped", sent);
                }
                if (inGame)
                {
                    GameInput.Enqueue(name, true);
                    try
                    {
                        Wait(hold);
                    }
                    finally
                    {
                        GameInput.Enqueue(name, false);  // never leave a button held down
                    }
                    sent++;
                    Wait(gap);
                    continue;
                }
                var why = FocusError();
                if (why != null)
                {
                    return Failed(why, sent);
                }
                Native.Key(code.Vk, false, code.Extended);
                try
                {
                    Wait(hold);
                }
                finally
                {
                    Native.Key(code.Vk, true, code.Extended);  // never leave a key held down
                }
                sent++;
                Wait(gap);
            }
        }
        return new JsonObject { ["ok"] = true, ["sent"] = sent, ["via"] = inGame ? "game" : "sendinput" };
    }

    /// <summary>
    /// {"op": "hold", "key": "Down", "down": true, "ms": 1500}: holds a game button until let go
    /// or for at most `ms`, renewed by holding again (GameInput.Hold). Walking needs a held key.
    /// </summary>
    private static JsonObject Hold(JsonObject command)
    {
        var name = command["key"]?.GetValue<string>() ?? "";
        if (!GameInput.Knows(name))
        {
            return Failed($"no_game_button:{name}");
        }
        var down = command["down"]?.GetValue<bool>() ?? false;
        var ms = Math.Clamp(command["ms"]?.GetValue<int>() ?? 1000, 50, MaxHoldMs);
        GameInput.Hold(name, down, ms);
        return new JsonObject { ["ok"] = true };
    }

    private static JsonObject Status()
    {
        var why = FocusError();
        return new JsonObject
        {
            ["ok"] = true,
            ["focused"] = why == null,
            ["locked"] = why == "locked",
            ["foreground"] = ForegroundName(),
            // 0.9.0: "via": "game" and "hold" press a virtual gamepad that needs no focus.
            ["gameButtons"] = true,
        };
    }

    /// <summary>Null when the game's own window is in front; otherwise "locked" or "not_focused".</summary>
    private static string FocusError()
    {
        var hwnd = Native.GetForegroundWindow();
        Native.GetWindowThreadProcessId(hwnd, out var pid);
        if (pid == OwnPid)
        {
            var name = new StringBuilder(64);
            Native.GetClassName(hwnd, name, name.Capacity);
            if (name.ToString() == "UnityWndClass")
            {
                return null;
            }
        }
        return ForegroundName() is "LockApp" or "LogonUI" ? "locked" : "not_focused";
    }

    private static string ForegroundName()
    {
        Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out var pid);
        if (pid == 0)
        {
            return "";
        }
        try
        {
            using var p = Process.GetProcessById((int)pid);
            return p.ProcessName;
        }
        catch (Exception)
        {
            return "";
        }
    }

    /// <summary>Sleeps, waking early when a stop arrives.</summary>
    private static void Wait(int ms)
    {
        var until = Environment.TickCount64 + ms;
        while (!_stop && Environment.TickCount64 < until)
        {
            Thread.Sleep((int)Math.Min(10, until - Environment.TickCount64));
        }
    }

    private static JsonObject Failed(string error, int sent = 0) =>
        new() { ["ok"] = false, ["error"] = error, ["sent"] = sent };

    private static void Reply(WebSocket to, JsonObject command, JsonObject result)
    {
        var reply = new JsonObject { ["type"] = "reply", ["frame"] = Probe.Frame };
        var id = command?["id"];
        reply["re"] = id == null ? null : JsonNode.Parse(id.ToJsonString());
        reply["op"] = command?["op"]?.GetValue<string>();
        foreach (var (key, value) in result)
        {
            reply[key] = value == null ? null : JsonNode.Parse(value.ToJsonString());
        }
        Plugin.Outbox.Reply(to, Emit.Serialize(reply));
    }

    private static Dictionary<string, (ushort, bool)> BuildCodes()
    {
        var codes = new Dictionary<string, (ushort, bool)>
        {
            ["Up"] = (0x26, true), ["Down"] = (0x28, true), ["Left"] = (0x25, true), ["Right"] = (0x27, true),
            ["Enter"] = (0x0D, false), ["Space"] = (0x20, false), ["Backspace"] = (0x08, false),
            ["Escape"] = (0x1B, false), ["Tab"] = (0x09, false), ["Shift"] = (0xA0, false),
            ["Ctrl"] = (0xA2, false), ["Alt"] = (0xA4, false), ["PageUp"] = (0x21, true),
            ["PageDown"] = (0x22, true), ["Home"] = (0x24, true), ["End"] = (0x23, true),
            ["Insert"] = (0x2D, true), ["Delete"] = (0x2E, true),
        };
        foreach (var c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        {
            codes[c.ToString()] = (c, false);
        }
        for (var n = 1; n <= 12; n++)
        {
            codes[$"F{n}"] = ((ushort)(0x6F + n), false);
        }
        return codes;
    }

    private static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct KeyboardInput
        {
            public ushort Vk;
            public ushort Scan;
            public uint Flags;
            public uint Time;
            public IntPtr ExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MouseInput
        {
            public int Dx;
            public int Dy;
            public uint MouseData;
            public uint Flags;
            public uint Time;
            public IntPtr ExtraInfo;
        }

        // The union must be as large as its largest member, or SendInput rejects the size.
        [StructLayout(LayoutKind.Explicit)]
        private struct InputUnion
        {
            [FieldOffset(0)] public MouseInput Mouse;
            [FieldOffset(0)] public KeyboardInput Keyboard;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct Input
        {
            public uint Type;
            public InputUnion U;
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint count, Input[] inputs, int size);

        [DllImport("user32.dll")]
        private static extern uint MapVirtualKey(uint code, uint mapType);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);

        // Scan codes rather than virtual keys: games reading raw input see scan codes.
        public static bool Key(ushort vk, bool up, bool extended)
        {
            const uint scancode = 0x0008, keyup = 0x0002, extendedKey = 0x0001;
            var input = new Input { Type = 1 };
            input.U.Keyboard = new KeyboardInput
            {
                Vk = vk,
                Scan = (ushort)MapVirtualKey(vk, 0),
                Flags = scancode | (up ? keyup : 0) | (extended ? extendedKey : 0),
            };
            return SendInput(1, new[] { input }, Marshal.SizeOf<Input>()) == 1;
        }
    }
}
