#if FF5
using System;
using System.Text.Json.Nodes;
using Last.Management;
using Last.Timer;

namespace FfprBridge;

/// <summary>
/// FF5's on-screen countdown (Karnak Castle escape). The game runs it as a GrobalTimer through
/// TimerInstanceManager; the same timer is drawn on the map and in battle. Read-only.
/// </summary>
internal static partial class GameState
{
    internal struct CountdownState
    {
        public bool Present;
        public bool Active;
        public bool Finished;
        public bool Paused;
        public float Remaining;
        public float Elapsed;
        public float Required;
    }

    /// <summary>`timer` for sample / pos: the displayed countdown, if any.</summary>
    public static JsonObject Countdown()
    {
        try
        {
            ReadCountdown(out var s);
            return new JsonObject
            {
                ["active"] = s.Active,
                ["seconds"] = s.Active ? Round(Math.Max(0f, s.Remaining)) : null,
                ["paused"] = s.Active ? s.Paused : null,
            };
        }
        catch (Exception)
        {
            // Timer reads happen in pos too; a broken read must not take the position record down.
            return new JsonObject { ["active"] = false, ["seconds"] = null, ["paused"] = null };
        }
    }

    internal static bool ReadCountdown(out CountdownState s)
    {
        s = default;
        try
        {
            var manager = TimerInstanceManager.instance;
            var grobal = manager?.GrobalTimer;
            var timer = grobal?.Timer;
            if (timer == null)
            {
                return false;
            }
            s.Present = true;
            s.Finished = timer.isFinished;
            s.Paused = timer.isPause;
            s.Remaining = Math.Max(0f, timer.RemainingSeconds);
            s.Elapsed = timer.elapsedSec;
            s.Required = timer.requiredSec;
            // 推断，待真机核对: 卡纳克城逃脱用 SetGrobalTimer(..., isDisplayUI: true)，画面上
            // 那个框就是这个 GrobalTimer; isDisplayUI 为假的全局计时器不算倒计时。
            s.Active = grobal.IsDisplayUI && !s.Finished;
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }
}

/// <summary>
/// Pushes timer.start / timer.end when the visible countdown appears, restarts or goes away.
/// "finished" means the game's own timer says it ran out; "cleared" means it was removed first
/// (left the map, loaded a save, ...). Checked every 4 frames, like the position watcher.
/// </summary>
internal static class TimerWatch
{
    private const int Every = 4;

    private static int _frames;
    private static bool _active;
    private static float _lastElapsed;
    private static float _lastRequired;

    public static void Update()
    {
        if (++_frames % Every != 0)
        {
            return;
        }
        if (!GameState.ReadCountdown(out var s))
        {
            End("cleared");
            return;
        }
        var restarted = _active && s.Active &&
            (s.Required != _lastRequired || s.Elapsed + 0.5f < _lastElapsed);
        if (_active && (!s.Active || restarted))
        {
            End(restarted ? "restarted" : (s.Finished ? "finished" : "cleared"));
        }
        if (s.Active && !_active)
        {
            Emit.Event("timer.start", o =>
            {
                o["seconds"] = Math.Round(Math.Max(0f, s.Remaining), 1);
                o["paused"] = s.Paused;
                o["required"] = Math.Round(s.Required, 1);
            });
            _active = true;
        }
        _lastElapsed = s.Elapsed;
        _lastRequired = s.Required;
    }

    private static void End(string reason)
    {
        if (!_active)
        {
            return;
        }
        _active = false;
        Emit.Event("timer.end", o => o["reason"] = reason);
    }
}
#endif
