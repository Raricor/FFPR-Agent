using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
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
    };

    /// <summary>Where a StateEvent's state data starts: the 20-byte InputEvent, then the FourCC.</summary>
    private const int StateDataOffset = 24;

    private static readonly ConcurrentQueue<(string Name, bool Down)> Pending = new();
    /// <summary>Buttons held by "hold", each with the tick it is released at unless renewed.</summary>
    private static readonly ConcurrentDictionary<string, long> HeldUntil = new();
    private static Gamepad _pad;

    public static bool Knows(string name) => Buttons.ContainsKey(name);

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

    /// <summary>Lets go of every held button ("stop").</summary>
    public static void ReleaseAll()
    {
        foreach (var name in HeldUntil.Keys)
        {
            Hold(name, false, 0);
        }
    }

    /// <summary>On the game thread: each queued transition becomes one gamepad state event.</summary>
    public static void Drain()
    {
        var now = Environment.TickCount64;
        foreach (var held in HeldUntil)
        {
            if (held.Value <= now)
            {
                Hold(held.Key, false, 0);
            }
        }
        if (Pending.IsEmpty)
        {
            return;
        }
        var pad = Pad();
        while (Pending.TryDequeue(out var item))
        {
            Send(pad, Buttons[item.Name](pad), item.Down);
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
    /// The pad's current state with one button's bit changed, queued as a state event. The bit is
    /// set by hand: interop methods returning pointers (GetStatePtrFromStateEvent) throw
    /// BadImageFormatException (10-27), and each button the engine uses is one bit.
    /// </summary>
    private static unsafe void Send(Gamepad pad, ButtonControl button, bool down)
    {
        StateEvent.From(pad, out var eventPtr, Allocator.Temp);  // freed at the frame's end
        // InputEventPtr holds one field, the event's address.
        var state = (byte*)Unsafe.As<InputEventPtr, IntPtr>(ref eventPtr) + StateDataOffset;
        var block = button.stateBlock;
        var bit = (block.byteOffset - pad.stateBlock.byteOffset) * 8 + block.bitOffset;
        var mask = (byte)(1 << (int)(bit % 8));
        state[bit / 8] = down ? (byte)(state[bit / 8] | mask) : (byte)(state[bit / 8] & ~mask);
        InputSystem.QueueEvent(eventPtr);
    }
}
