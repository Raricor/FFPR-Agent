using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using BepInEx;
using BepInEx.Logging;

namespace FfprBridge;

/// <summary>
/// What the tray app on the laptop asks for with {"op": "bridge"} (0.12.0): the build's identity,
/// who is connected, which hooks went in, the last 100 key commands and the last 50 warnings.
/// Everything here is a plain managed object, and the socket threads, the key thread, the log
/// listener and the game thread all read or write it, so one lock guards all of it. Nothing here
/// touches an IL2CPP object.
/// </summary>
internal static class BridgeInfo
{
    private const int MaxKeys = 100;
    private const int MaxWarnings = 50;
    private const int MaxSender = 32;

    private static readonly object Gate = new();
    private static readonly List<KeyRecord> Keys = new();
    private static readonly List<WarningRecord> Warnings = new();
    private static readonly List<string> HooksOk = new();
    private static readonly List<(string Name, string Error)> HooksFailed = new();
    private static readonly DateTime StartedAt = DateTime.UtcNow;
    private static ManualLogSource _source;

    /// <summary>Records the log source whose warnings the panel shows; call once from Start.</summary>
    public static void Begin(ManualLogSource source)
    {
        _source = source;
        Logger.Listeners.Add(new WarningListener());
    }

    public static void HookOk(string name)
    {
        lock (Gate)
        {
            HooksOk.Add(name);
        }
    }

    public static void HookFailed(string name, string error)
    {
        lock (Gate)
        {
            HooksFailed.Add((name, error));
        }
    }

    /// <summary>One record per keys command, with who sent it and what came of it.</summary>
    public static void KeyCommand(string remote, JsonObject command, JsonObject result)
    {
        try
        {
            var record = new KeyRecord
            {
                At = DateTime.UtcNow,
                Sender = Sender(command),
                Remote = remote,
                Via = command["via"]?.GetValue<string>() == "game" ? "game" : "sendinput",
                Keys = KeysOf(command),
                Ok = result["ok"]?.GetValue<bool>() ?? false,
                Error = result["error"]?.GetValue<string>(),
            };
            lock (Gate)
            {
                Keys.Add(record);
                if (Keys.Count > MaxKeys)
                {
                    Keys.RemoveAt(0);
                }
            }
        }
        catch (Exception)
        {
            // Diagnostics must never fail a key press that has already happened.
        }
    }

    /// <summary>The reply to {"op": "bridge"}.</summary>
    public static JsonObject Snapshot()
    {
        var outbox = Plugin.Outbox;
        return new JsonObject
        {
            ["game"] = Plugin.GameKey,
            ["version"] = Plugin.Version,
            ["process"] = Paths.ProcessName,
            ["startedAt"] = StartedAt.ToString("O"),
            ["port"] = outbox == null ? 0 : outbox.Port,
            ["lan"] = Lan(outbox),
            ["clients"] = outbox == null ? new JsonArray() : outbox.Clients(),
            ["hooks"] = Hooks(),
            ["keys"] = KeysJson(),
            ["warnings"] = WarningsJson(),
        };
    }

    private static JsonObject Lan(Outbox outbox)
    {
        var link = outbox == null ? null : outbox.Lan;
        return new JsonObject
        {
            ["enabled"] = link != null,
            ["listen"] = link?.Listen.ToString(),
        };
    }

    private static JsonObject Hooks()
    {
        var ok = new JsonArray();
        var failed = new JsonArray();
        lock (Gate)
        {
            foreach (var name in HooksOk)
            {
                ok.Add(name);
            }
            foreach (var (name, error) in HooksFailed)
            {
                failed.Add(new JsonObject { ["name"] = name, ["error"] = error });
            }
        }
        return new JsonObject { ["ok"] = ok, ["failed"] = failed };
    }

    private static JsonArray KeysJson()
    {
        var array = new JsonArray();
        lock (Gate)
        {
            foreach (var key in Keys)
            {
                var keys = new JsonArray();
                foreach (var spec in key.Keys)
                {
                    keys.Add(spec);
                }
                array.Add(new JsonObject
                {
                    ["at"] = key.At.ToString("O"),
                    ["from"] = key.Sender,
                    ["remote"] = key.Remote,
                    ["via"] = key.Via,
                    ["keys"] = keys,
                    ["ok"] = key.Ok,
                    ["error"] = key.Error,
                });
            }
        }
        return array;
    }

    private static JsonArray WarningsJson()
    {
        var array = new JsonArray();
        lock (Gate)
        {
            foreach (var warning in Warnings)
            {
                array.Add(new JsonObject
                {
                    ["at"] = warning.At.ToString("O"),
                    ["level"] = warning.Level,
                    ["text"] = warning.Text,
                });
            }
        }
        return array;
    }

    private static string Sender(JsonObject command)
    {
        try
        {
            var sender = command["from"]?.GetValue<string>();
            if (sender == null)
            {
                return null;
            }
            sender = sender.Trim();
            if (sender.Length == 0)
            {
                return null;
            }
            return sender.Length > MaxSender ? sender.Substring(0, MaxSender) : sender;
        }
        catch (Exception)
        {
            // A non-string "from" is simply treated as absent.
            return null;
        }
    }

    private static string[] KeysOf(JsonObject command)
    {
        if (command["keys"] is not JsonArray specs)
        {
            return Array.Empty<string>();
        }
        var keys = new List<string>();
        foreach (var spec in specs)
        {
            keys.Add(spec?.GetValue<string>() ?? "");
        }
        return keys.ToArray();
    }

    private static void Warning(LogLevel level, object data)
    {
        try
        {
            var record = new WarningRecord
            {
                At = DateTime.UtcNow,
                Level = level.ToString(),
                Text = data?.ToString() ?? "",
            };
            lock (Gate)
            {
                Warnings.Add(record);
                if (Warnings.Count > MaxWarnings)
                {
                    Warnings.RemoveAt(0);
                }
            }
        }
        catch (Exception)
        {
            // A warning we cannot record must not take the game down.
        }
    }

    /// <summary>Only this plugin's Warning/Error/Fatal lines; the loader and the game log are not ours.</summary>
    private sealed class WarningListener : ILogListener
    {
        public LogLevel LogLevelFilter => LogLevel.Warning | LogLevel.Error | LogLevel.Fatal;

        public void LogEvent(object sender, LogEventArgs e)
        {
            if (!ReferenceEquals(e.Source, _source))
            {
                return;
            }
            if ((e.Level & (LogLevel.Warning | LogLevel.Error | LogLevel.Fatal)) == 0)
            {
                return;
            }
            Warning(e.Level, e.Data);
        }

        public void Dispose()
        {
        }
    }

    private sealed class KeyRecord
    {
        public DateTime At;
        public string Sender;
        public string Remote;
        public string Via;
        public string[] Keys;
        public bool Ok;
        public string Error;
    }

    private sealed class WarningRecord
    {
        public DateTime At;
        public string Level;
        public string Text;
    }
}
