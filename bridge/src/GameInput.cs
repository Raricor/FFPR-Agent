using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using Il2CppInterop.Runtime;
using Unity.Collections;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.Controls;
using UnityEngine.InputSystem.LowLevel;

namespace FfprBridge;

/// <summary>
/// Presses buttons on a virtual gamepad inside the game's own input system, so the game can be
/// played while its window is in the background or minimized (10-27, the user's choice, so the
/// laptop stays usable). Why a gamepad, 10-27 live:
/// <list type="bullet">
/// <item>SendInput feeds the global keyboard: only the foreground window gets it, and it fights
/// a person typing. Window messages never reach the game either (PostMessage did nothing).</item>
/// <item>The game's input actions bind gamepads only (Enter = buttonSouth, Cancel = buttonEast,
/// Menu = buttonNorth, the d-pad); its keyboard is read elsewhere, so a pressed key on the
/// input system's keyboard moved nothing.</item>
/// </list>
/// This writes button state into the game's input system and nothing else: no game data, no
/// save. The keyboard thread queues transitions; the game thread applies them in Probe.Update.
/// </summary>
internal static class GameInput
{
    /// <summary>The engine's key names and the action each has with the game's default keys.</summary>
    private static readonly Dictionary<string, Func<Gamepad, ButtonControl>> Buttons = new()
    {
        ["Enter"] = pad => pad.buttonSouth,      // confirm
        ["Backspace"] = pad => pad.buttonEast,   // cancel
        ["Tab"] = pad => pad.buttonNorth,        // main menu
        ["Up"] = pad => pad.dpad.up,
        ["Down"] = pad => pad.dpad.down,
        ["Left"] = pad => pad.dpad.left,
        ["Right"] = pad => pad.dpad.right,
        // 10-28: the rest of the pad, for screens with more actions (FF3's random name is "Q").
        ["PadWest"] = pad => pad.buttonWest,
        ["PadL1"] = pad => pad.leftShoulder,
        ["PadR1"] = pad => pad.rightShoulder,
        ["PadStart"] = pad => pad.startButton,
        ["PadSelect"] = pad => pad.selectButton,
    };

    /// <summary>Where a StateEvent's state data starts: the 20-byte InputEvent, then the FourCC.</summary>
    private const int StateDataOffset = 24;

    private static readonly ConcurrentQueue<(string Name, bool Down)> Pending = new();
    /// <summary>Buttons held by "hold", each with the tick it is released at unless renewed.</summary>
    private static readonly ConcurrentDictionary<string, long> HeldUntil = new();
    /// <summary>The state last sent for every known button; game thread only.</summary>
    private static Dictionary<string, bool> _wanted = new();
    /// <summary>Set by ReleaseAll: send a full "all up" event even if nothing seems changed.</summary>
    private static volatile bool _forceSend;
    /// <summary>Transitions held back because their button already changed this frame; game thread only.</summary>
    private static readonly List<(string Name, bool Down)> Deferred = new();
    private static Gamepad _pad;

    /// <summary>
    /// 10-28: the naming boxes (FF2's new game, FF6's every new member) are text fields that read
    /// only the real keyboard, so no gamepad button closes them. "TextEnter" is the Enter key for
    /// the field being typed in: it ends input the way Enter does, keeping the name shown.
    /// </summary>
    public const string TextEnter = "TextEnter";

    public static bool Knows(string name) => Buttons.ContainsKey(name) || name == TextEnter;

    public static void Enqueue(string name, bool down) => Pending.Enqueue((name, down));

    /// <summary>
    /// Holds a button for at most `ms` unless renewed, or lets it go. The deadline is the safety:
    /// a walker that dies mid-walk must not leave the party walking forever.
    /// </summary>
    public static void Hold(string name, bool down, int ms)
    {
        if (down)
        {
            HeldUntil[name] = Environment.TickCount64 + ms;
        }
        else
        {
            HeldUntil.TryRemove(name, out _);
        }
        Pending.Enqueue((name, down));
    }

    /// <summary>
    /// Lets go of every known button ("stop" and the end of a walk). This is not limited to
    /// HeldUntil: the 0.14.0 bug left a direction down after it was no longer tracked.
    /// </summary>
    public static void ReleaseAll()
    {
        HeldUntil.Clear();
        Pending.Enqueue((null, false));
        _forceSend = true;  // after the marker: a Drain that sees the marker also sees the flag
    }

    /// <summary>
    /// On the game thread: merge all expired holds and queued transitions into one complete
    /// wanted state, then send at most one gamepad state event for the frame. The old code read
    /// the pad's current state for each change, so two changes in one frame both started from
    /// the pre-frame state and the first was undone by the second (0.14.0 stuck keys).
    /// </summary>
    public static void Drain()
    {
        var now = Environment.TickCount64;
        var force = _forceSend;
        _forceSend = false;
        if (!force && Pending.IsEmpty && Deferred.Count == 0)
        {
            var expired = false;
            foreach (var held in HeldUntil)
            {
                if (held.Value <= now)
                {
                    expired = true;
                    break;
                }
            }
            if (!expired)
            {
                return;
            }
        }
        var target = new Dictionary<string, bool>(_wanted);
        var touched = new HashSet<string>();
        var next = new List<(string Name, bool Down)>();
        var earlier = new List<(string Name, bool Down)>(Deferred);
        Deferred.Clear();

        // 1. Expired holds first: their release must not be swallowed by a new press below.
        // Remove only the exact entry we saw: a command-thread renewal in between changes its
        // value, and removing blindly would drop the new deadline and leave the key stuck down.
        var holds = (ICollection<KeyValuePair<string, long>>)HeldUntil;
        foreach (var held in HeldUntil)
        {
            if (held.Value > now || !holds.Remove(held))
            {
                continue;
            }
            if (target.TryGetValue(held.Key, out var down) && down)
            {
                target[held.Key] = false;
                touched.Add(held.Key);
            }
        }

        // 2. Transitions held back from the previous frame, then this frame's queue, in order.
        foreach (var item in earlier)
        {
            Apply(item.Name, item.Down);
        }
        while (Pending.TryDequeue(out var item))
        {
            Apply(item.Name, item.Down);
        }

        var changed = false;
        foreach (var name in Buttons.Keys)
        {
            target.TryGetValue(name, out var want);
            _wanted.TryGetValue(name, out var had);
            if (want != had)
            {
                changed = true;
                break;
            }
        }
        force = force || _forceSend;
        _forceSend = false;
        // A stale bit can only exist after an event was sent, so the forced all-up needs a pad.
        if (changed || (force && _pad != null && _pad.added))
        {
            Send(Pad(), target);
            _wanted = target;
        }
        Deferred.AddRange(next);

        // One transition per button per frame; only the first change is visible now, the rest
        // wait so a press followed by a release (or the reverse) is never cancelled out.
        void Apply(string name, bool down)
        {
            if (name == TextEnter)
            {
                if (down)
                {
                    SubmitText();
                }
                return;
            }
            if (name == null)
            {
                // "all up": also cancels transitions we already deferred this frame.
                foreach (var key in Buttons.Keys)
                {
                    target[key] = false;
                    touched.Add(key);
                }
                HeldUntil.Clear();
                next.Clear();
                return;
            }
            if (!Buttons.ContainsKey(name))
            {
                return;
            }
            target.TryGetValue(name, out var current);
            if (touched.Contains(name))
            {
                // A later transition for a button that already changed this frame waits its turn,
                // even if it would bring the state back: a press and its release must both show.
                next.Add((name, down));
                return;
            }
            if (current == down)
            {
                return;  // already in that state; a redundant transition needs no event
            }
            target[name] = down;
            touched.Add(name);
        }
    }

    /// <summary>
    /// The virtual gamepad, added on first use. The default background behavior disables devices
    /// while the window is not focused, which would drop these events; a person's keyboard still
    /// reaches only the foreground window (raw input without input-sink).
    /// </summary>
    private static Gamepad Pad()
    {
        if (_pad != null && _pad.added)
        {
            return _pad;
        }
        var settings = InputSystem.settings;
        if (settings != null && settings.backgroundBehavior != InputSettings.BackgroundBehavior.IgnoreFocus)
        {
            Plugin.Logger.LogInfo($"输入系统的后台行为 {settings.backgroundBehavior} 改成 IgnoreFocus");
            settings.backgroundBehavior = InputSettings.BackgroundBehavior.IgnoreFocus;
        }
        _pad = InputSystem.AddDevice("Gamepad", "FFPR Agent Gamepad").TryCast<Gamepad>();
        Plugin.Logger.LogInfo($"加了虚拟手柄 {_pad.deviceId}");
        return _pad;
    }

    /// <summary>
    /// Queues one state event whose every known button bit comes from the wanted state. Writing
    /// all of them (not just the changed one) also clears a button that earlier code left down.
    /// The bit is set by hand: interop methods returning pointers (GetStatePtrFromStateEvent)
    /// throw BadImageFormatException (10-27), and each button the engine uses is one bit.
    /// </summary>
    private static unsafe void Send(Gamepad pad, Dictionary<string, bool> wanted)
    {
        StateEvent.From(pad, out var eventPtr, Allocator.Temp);  // freed at the frame's end
        // InputEventPtr holds one field, the event's address.
        var state = (byte*)Unsafe.As<InputEventPtr, IntPtr>(ref eventPtr) + StateDataOffset;
        foreach (var pair in Buttons)
        {
            var block = pair.Value(pad).stateBlock;
            var bit = (block.byteOffset - pad.stateBlock.byteOffset) * 8 + block.bitOffset;
            var mask = (byte)(1 << (int)(bit % 8));
            var down = wanted.TryGetValue(pair.Key, out var value) && value;
            state[bit / 8] = down ? (byte)(state[bit / 8] | mask) : (byte)(state[bit / 8] & ~mask);
        }
        InputSystem.QueueEvent(eventPtr);
    }

    /// <summary>Enter for the focused text field: UGUI's DeactivateInputField sends onEndEdit.</summary>
    private static void SubmitText()
    {
        foreach (var found in UnityEngine.Object.FindObjectsOfType(Il2CppType.Of<UnityEngine.UI.InputField>()))
        {
            var field = found.TryCast<UnityEngine.UI.InputField>();
            if (field != null && field.isFocused)
            {
                Plugin.Logger.LogInfo($"文字输入框按了 Enter:{field.text}");
                field.DeactivateInputField();
                return;
            }
        }
        Plugin.Logger.LogInfo("TextEnter:没有正在输入的文字框");
    }
}
