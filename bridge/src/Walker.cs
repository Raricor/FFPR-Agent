using System;
using System.Collections.Generic;
using System.Net.WebSockets;
using System.Text.Json.Nodes;
using System.Threading;
using Last.Battle;
using Last.Management;
using Last.Message;
using UnityEngine;
using Singleton = Il2CppSystem.SingletonMonoBehaviour<Last.Message.MessageWindowManager>;

namespace FfprBridge;

/// <summary>
/// 0.14.0: one walk command. The command thread fills it in and waits on <see cref="Done"/>; the
/// game thread owns <see cref="State"/> and writes the reply, so the two never touch the same
/// fields except through the volatile/Interlocked handshake.
/// </summary>
internal sealed class WalkRequest
{
    public int[][] Path;
    public bool PathValid;         // every step is four-way adjacent
    public int Seq;                // 1-based walkpath number since the bridge started
    public int[] Goal;             // display only; may be null
    public string Label;           // display only; at most 80 chars
    public string StartedAt;       // ISO UTC, set on the command thread
    public int TimeoutMs;
    public int BlockedMs;
    public float TurnLead;
    public WebSocket From;
    public WalkState State;

    public readonly ManualResetEventSlim Done = new(false);

    private string _cancel;
    private JsonObject _result;

    /// <summary>Set by the command thread (stop, closed connection, its own timeout).</summary>
    public string Cancel
    {
        get => Volatile.Read(ref _cancel);
        set
        {
            if (value != null)
            {
                Interlocked.CompareExchange(ref _cancel, value, null);
            }
        }
    }

    public JsonObject Result => Volatile.Read(ref _result);

    public void Finish(JsonObject result)
    {
        Volatile.Write(ref _result, result);
        Done.Set();
    }
}

/// <summary>Walk progress, owned by the game thread for the lifetime of one command.</summary>
internal sealed class WalkState
{
    public int Index;              // path index of the cell the player is on / last reached
    public int Steps;
    public int TurnedFor = -1;     // Index whose corner we already switched keys at
    public bool Recovering;        // walking back to the path after overshooting a corner
    public int RecoverIndex;
    public string Key;             // direction button currently held, if any
    public long StartedAt;
    public long GimmickSince;
    public long BlockedSince;
    public long AtEndSince;
    public Vector3 LastExact;
    public bool HasLastExact;
    public int? MapId;
    public bool Started;
    public bool Finished;
    public int[] CurrentCell;      // rounded player cell, updated once per frame
    public bool SawFraction;       // any reading had a fractional cell part (lead mode)
    public bool SawStillAtFrom;    // saw the arrival frame (moving == false) at path[Index]
    public Vector3 RawLocal;       // player.transform.localPosition for turns.raw
    public bool HasRawLocal;
    public bool Announced;         // walk.start has gone out for this request
    public bool ProgressPending;
    public long ProgressLastAt;
    public int LastProgressIndex = -1;
    public readonly JsonArray Turns = new();
}

/// <summary>
/// What the `walk` query answers and what the walk.* events carry. The game thread owns it:
/// Announce writes it when a walkpath starts, Update keeps it current, Finish closes it. It is
/// the last walkpath only; an older record is replaced, never edited.
/// </summary>
internal sealed class WalkRecord
{
    public int Seq;
    public int? Map;
    public int[][] Path;
    public int[] Goal;
    public string Label;
    public string StartedAt;
    public int Index;
    public int Steps;
    public int[] Cell;
    public JsonArray Turns;
    public bool Active;
    public string EndedAt;
    public string Reason;
}

/// <summary>
/// Walks a whole route on the game thread, one frame at a time, without stopping at corners.
/// The command thread hands over the request (<see cref="Run"/>) and waits; every frame
/// <see cref="Update"/> presses the direction of the next cell through GameInput and reads the
/// fractional cell position back. The route is validated once, before a single key is pressed.
///
/// Keys are renewed with GameInput.Hold every frame and expire on their own after 250 ms, so a
/// bridge that dies mid-walk leaves the party standing still. Only the virtual gamepad's d-pad
/// is touched; no game data is written.
/// </summary>
internal static class Walker
{
    private const int MaxTurns = 64;
    private const int HoldMs = 250;
    private const float LeftCenter = 0.1f;   // "已离开上一格中心" 的阈值,单位是格
    private const int GimmickWaitMs = 5000;
    private const int ArriveSettleMs = 400;

    private static readonly object Gate = new();
    private static volatile WalkRequest _request;
    private static int _seqCounter;
    private static WalkRecord _record;  // game thread only

    /// <summary>Command thread: parse, hand the route to the game thread, wait for the reply.</summary>
    public static JsonObject Run(WebSocket from, JsonObject command)
    {
        var path = ParsePath(command["path"]);
        var request = new WalkRequest
        {
            Path = path,
            PathValid = Adjacent(path),
            Seq = Interlocked.Increment(ref _seqCounter),
            Goal = ParsePoint(command["goal"]),
            Label = ParseLabel(command["label"]),
            StartedAt = DateTime.UtcNow.ToString("O"),
            TimeoutMs = ClampInt(command["timeoutMs"], 60000, 1, 300000),
            BlockedMs = ClampInt(command["blockedMs"], 800, 1, 60000),
            TurnLead = ClampFloat(command["turnLead"], 0.6f, 0f, 2f),
            From = from,
            State = new WalkState(),
        };
        lock (Gate)
        {
            _request = request;
            var deadline = Environment.TickCount64 + request.TimeoutMs;
            while (!request.Done.IsSet)
            {
                if (Keyboard.StopRequested)
                {
                    request.Cancel = "stopped";
                }
                else if (!Open(from))
                {
                    request.Cancel = "closed";
                }
                else if (Environment.TickCount64 >= deadline)
                {
                    request.Cancel = "timeout";
                }
                if (request.Cancel != null)
                {
                    // Let go from this thread too: if the game thread is stuck loading, the keys
                    // would otherwise stay down until their 250 ms deadline.
                    GameInput.ReleaseAll();
                    request.Done.Wait(500);  // let the game thread report pos while it still can
                    break;
                }
                request.Done.Wait(20);
            }
            if (ReferenceEquals(_request, request))
            {
                _request = null;
            }
            return request.Result ?? Fallback(request);
        }
    }

    /// <summary>Reply for a walkpath that a "stop" removed from the queue before it started.</summary>
    public static JsonObject StoppedReply() => new()
    {
        ["ok"] = false,
        ["reason"] = "stopped",
        ["index"] = -1,
        ["steps"] = 0,
        ["pos"] = null,
        ["next"] = null,
        ["turns"] = new JsonArray(),
    };

    /// <summary>Game thread: the `walk` query's record, or null when no walkpath ever ran.</summary>
    public static JsonObject Snapshot()
    {
        var record = _record;
        if (record == null)
        {
            return null;
        }
        return new JsonObject
        {
            ["seq"] = record.Seq,
            ["active"] = record.Active,
            ["map"] = record.Map,
            ["path"] = PathNode(record.Path),
            ["goal"] = CellNode(record.Goal),
            ["label"] = record.Label,
            ["index"] = record.Index,
            ["steps"] = record.Steps,
            ["cell"] = CellNode(record.Cell),
            ["segment"] = SegmentNode(record.Path, record.Index),
            ["turns"] = record.Turns == null ? new JsonArray() : JsonNode.Parse(record.Turns.ToJsonString()),
            ["startedAt"] = record.StartedAt,
            ["endedAt"] = record.EndedAt,
            ["reason"] = record.Reason,
        };
    }

    /// <summary>Game thread: advance the active walk by one frame.</summary>
    public static void Update()
    {
        var request = _request;
        if (request == null)
        {
            return;
        }
        var state = request.State;
        if (request.Done.IsSet)
        {
            // The command thread gave up (its own timeout/stop/closed) before we did.
            if (!state.Finished)
            {
                state.Finished = true;
                Release(state);
                GameInput.ReleaseAll();  // also clears a button no longer in HeldUntil
            }
            return;
        }
        try
        {
            Step(request, state);
        }
        catch (Exception e)
        {
            Plugin.Logger.LogWarning($"walkpath:{e}");
            Finish(request, state, "stopped", state.Started && !state.Recovering ? state.Index : -1);
        }
        if (!state.Finished)
        {
            SyncRecord(request, state);
            EmitProgress(request, state, Environment.TickCount64, false);
        }
    }

    private static void Step(WalkRequest request, WalkState state)
    {
        var now = Environment.TickCount64;
        var cancel = request.Cancel;
        if (cancel == null && Keyboard.StopRequested)
        {
            cancel = "stopped";
        }
        if (cancel == null && !Open(request.From))
        {
            cancel = "closed";
        }

        string main = null;
        var battle = false;
        var dialog = false;
        int? map = null;
        var hasExact = false;
        Vector3 exact = default;
        try
        {
            main = GameState.MainState();
        }
        catch (Exception)
        {
            // Scene swap: the state read can fail for a frame or two.
        }
        try
        {
            battle = BattlePlugManager.instance?.isBattle ?? false;
        }
        catch (Exception)
        {
        }
        try
        {
            dialog = Singleton.instance != null && Singleton.instance.IsOpen();
        }
        catch (Exception)
        {
        }
        try
        {
            map = UserDataManager.instance?.CurrentMapId;
        }
        catch (Exception)
        {
        }
        try
        {
            hasExact = GameState.TryPlayerCellExact(out exact);
        }
        catch (Exception)
        {
        }
        var moving = false;
        state.HasRawLocal = false;
        if (hasExact)
        {
            try
            {
                if (GameState.TryPlayer(out _, out var player))
                {
                    moving = player.IsMoving;
                    state.RawLocal = player.transform.localPosition;
                    state.HasRawLocal = true;
                }
            }
            catch (Exception)
            {
            }
        }
        var cell = hasExact ? RoundCell(exact) : null;
        state.CurrentCell = cell;
        // The world map returns whole cells; indoors it may be fractional. Once a fractional
        // reading is seen the original turnLead rule is used; otherwise the step rule below.
        if (hasExact && IsFractional(exact))
        {
            state.SawFraction = true;
        }
        if (!state.Announced)
        {
            var initial = request.PathValid && cell != null
                ? FindCellFrom(request.Path, cell, 0)
                : -1;
            Announce(request, state, map, cell, initial, now);
        }
        // A malformed or non-adjacent route is rejected before any key is pressed.
        if (!request.PathValid)
        {
            Finish(request, state, "bad_path", -1);
            return;
        }
        var indexNow = cell == null
            ? (state.Started && !state.Recovering ? state.Index : -1)
            : FindCellFrom(request.Path, cell, state.Started ? state.Index : 0);

        if (cancel != null)
        {
            Finish(request, state, cancel, indexNow);
            return;
        }
        if (battle)
        {
            Finish(request, state, "battle", indexNow);
            return;
        }
        if (dialog)
        {
            Finish(request, state, "dialog", indexNow);
            return;
        }
        if (state.Started && map != null && map != state.MapId)
        {
            Finish(request, state, "map_changed", indexNow);
            return;
        }
        if (main != "Player" && main != "Transport")
        {
            if (main == "Gimmick")
            {
                // A door/lever: let go and wait; most gimmicks hand control back quickly.
                Release(state);
                if (state.GimmickSince == 0)
                {
                    state.GimmickSince = now;
                }
                else if (now - state.GimmickSince >= GimmickWaitMs)
                {
                    Finish(request, state, "state:Gimmick", indexNow);
                }
                return;
            }
            Finish(request, state, main == null ? "no_player" : "state:" + main, indexNow);
            return;
        }
        if (state.GimmickSince != 0)
        {
            state.GimmickSince = 0;
            state.BlockedSince = now;
            state.SawStillAtFrom = false;
        }
        if (map == null)
        {
            Finish(request, state, "no_player", -1);
            return;
        }
        if (!hasExact)
        {
            Finish(request, state, "no_player", -1);
            return;
        }

        if (!state.Started)
        {
            var start = FindCell(request.Path, cell);
            if (start < 0)
            {
                Finish(request, state, "off_path", -1);
                return;
            }
            state.Started = true;
            state.Index = start;
            state.MapId = map;
            state.StartedAt = now;
            state.BlockedSince = now;
            state.LastExact = exact;
            state.HasLastExact = true;
            state.SawStillAtFrom = false;
        }

        if (now - state.StartedAt > request.TimeoutMs)
        {
            Finish(request, state, "timeout", indexNow);
            return;
        }
        TrackPosition(state, exact, now, moving);

        if (state.Recovering)
        {
            Recovery(request, state, cell, exact, now, moving);
        }
        else
        {
            Normal(request, state, cell, exact, now, moving);
        }
    }

    /// <summary>Walking forward along the route, including the early key switch at corners.</summary>
    private static void Normal(WalkRequest request, WalkState state, int[] cell, Vector3 exact, long now, bool moving)
    {
        var path = request.Path;
        while (state.Index + 1 < path.Length && Same(cell, path[state.Index + 1]))
        {
            var before = state.Index;
            state.Index++;
            state.Steps++;
            var arrived = path[state.Index];
            MarkTurnArrived(state, arrived, Probe.Frame);
            // A corner we reached before switching: still record where the switch happened.
            if (state.Index + 1 < path.Length &&
                Direction(path[state.Index - 1], arrived) !=
                Direction(arrived, path[state.Index + 1]) &&
                state.TurnedFor != before)
            {
                // No arrival frame at `from` was seen, so the key changes only now, when the
                // reading jumps to the corner; `flip` keeps this separate from step/lead.
                AddTurn(state, arrived, exact, true, "flip", Probe.Frame, moving);
            }
            if (!moving)
            {
                MarkTurnStopped(state, arrived, Probe.Frame);
            }
            state.TurnedFor = -1;
            state.SawStillAtFrom = false;
            state.BlockedSince = now;
            state.AtEndSince = 0;
        }

        if (!Same(cell, path[state.Index]))
        {
            var onPath = FindCellFrom(path, cell, state.Index);
            if (onPath >= 0)
            {
                // Not cell-locked: the rounded cell jumped past some route cells. Resync.
                if (onPath > state.Index)
                {
                    state.Steps += onPath - state.Index;
                }
                state.Index = onPath;
                state.TurnedFor = -1;
                state.SawStillAtFrom = false;
                state.BlockedSince = now;
                state.AtEndSince = 0;
            }
            else
            {
                var back = AdjacentIndex(path, cell, state.Index);
                if (back < 0)
                {
                    // More than one cell away from every route cell.
                    Finish(request, state, "off_path", -1);
                    return;
                }
                MarkTurnBad(state, path[back], exact, moving);
                state.Recovering = true;
                state.RecoverIndex = back;
                state.BlockedSince = now;
                Recovery(request, state, cell, exact, now, moving);
                return;
            }
        }

        if (state.Index == path.Length - 1)
        {
            Release(state);
            if (!moving)
            {
                Finish(request, state, "arrived", state.Index);
                return;
            }
            if (state.AtEndSince == 0)
            {
                state.AtEndSince = now;
            }
            if (now - state.AtEndSince >= ArriveSettleMs)
            {
                Finish(request, state, "arrived", state.Index);
            }
            return;
        }
        state.AtEndSince = 0;

        var from = path[state.Index];
        var to = path[state.Index + 1];
        if (Same(cell, from))
        {
            // Only the arrival frame (moving == false) proves this reading is the cell the player
            // actually reached. The reading can jump about three frames early, while still in the
            // previous step; that tail must not count as "departed from this cell".
            if (!moving)
            {
                state.SawStillAtFrom = true;
                MarkTurnStopped(state, from, Probe.Frame);
            }
        }
        else
        {
            state.SawStillAtFrom = false;
        }

        var key = Direction(from, to);
        if (state.Index + 2 < path.Length)
        {
            var outKey = Direction(to, path[state.Index + 2]);
            if (outKey != key && state.TurnedFor != state.Index)
            {
                if (state.SawFraction)
                {
                    // Fractional cell readings: the original lead rule, before the corner.
                    if (Distance(exact, to) <= request.TurnLead && Distance(exact, from) >= LeftCenter)
                    {
                        key = outKey;
                        state.TurnedFor = state.Index;
                        AddTurn(state, to, exact, true, "lead", null, moving);
                    }
                }
                else if (moving && Same(cell, from) && state.SawStillAtFrom)
                {
                    // Whole-cell readings (world map): the reading jumped to `from` early, but we
                    // waited for the arrival frame (moving false) on `from`; this frame it has set
                    // off again. The step is committed, so the out direction is safe to hold.
                    key = outKey;
                    state.TurnedFor = state.Index;
                    AddTurn(state, to, exact, true, "step", null, moving);
                }
            }
        }

        Press(state, key, now);
        if (now - state.BlockedSince > request.BlockedMs)
        {
            Finish(request, state, "blocked", state.Index, to);
        }
    }

    /// <summary>Walking back to the route after overshooting a corner by one cell.</summary>
    private static void Recovery(WalkRequest request, WalkState state, int[] cell, Vector3 exact, long now, bool moving)
    {
        var path = request.Path;
        if (Same(cell, path[state.RecoverIndex]))
        {
            if (state.RecoverIndex > state.Index)
            {
                state.Steps += state.RecoverIndex - state.Index;
            }
            state.Index = state.RecoverIndex;
            state.Recovering = false;
            state.TurnedFor = -1;
            state.SawStillAtFrom = false;
            state.BlockedSince = now;
            state.AtEndSince = 0;
            Normal(request, state, cell, exact, now, moving);
            return;
        }
        var onPath = FindCellFrom(path, cell, state.RecoverIndex);
        if (onPath >= 0)
        {
            if (onPath > state.Index)
            {
                state.Steps += onPath - state.Index;
            }
            state.Index = onPath;
            state.Recovering = false;
            state.TurnedFor = -1;
            state.SawStillAtFrom = false;
            state.BlockedSince = now;
            state.AtEndSince = 0;
            Normal(request, state, cell, exact, now, moving);
            return;
        }
        if (AdjacentIndex(path, cell, state.Index) < 0)
        {
            Finish(request, state, "off_path", -1);
            return;
        }
        var back = AdjacentIndex(path, cell, state.Index);
        state.RecoverIndex = back;
        var to = path[back];
        Press(state, Direction(cell, to), now);
        if (now - state.BlockedSince > request.BlockedMs)
        {
            Finish(request, state, "blocked", -1, to);
        }
    }

    private static void Press(WalkState state, string key, long now)
    {
        if (state.Key != key)
        {
            if (state.Key != null)
            {
                GameInput.Hold(state.Key, false, 0);
            }
            state.Key = key;
            state.BlockedSince = now;
        }
        // Renewed every frame; if the bridge stops updating, the button lets go by itself.
        GameInput.Hold(key, true, HoldMs);
    }

    private static void Release(WalkState state)
    {
        if (state.Key == null)
        {
            return;
        }
        GameInput.Hold(state.Key, false, 0);
        state.Key = null;
    }

    private static void TrackPosition(WalkState state, Vector3 exact, long now, bool moving)
    {
        // On the world map the cell reading only changes when a step finishes, so `moving`
        // tells us the step is still in progress and must not count as blocked.
        if (!state.HasLastExact || moving ||
            Vector2.Distance(new Vector2(exact.x, exact.y), new Vector2(state.LastExact.x, state.LastExact.y)) > 0.02f)
        {
            state.LastExact = exact;
            state.HasLastExact = true;
            state.BlockedSince = now;
        }
    }

    private static void Finish(WalkRequest request, WalkState state, string reason, int index, int[] next = null)
    {
        if (state.Finished)
        {
            return;
        }
        Release(state);
        // 0.14.1: clear every known button, not just the one this walker thinks it holds. The
        // let-go must reach the game before the reply leaves, not one frame later.
        GameInput.ReleaseAll();
        try
        {
            GameInput.Drain();
        }
        catch (Exception)
        {
            // Probe.Update drains again later; the button's 250 ms deadline is the last resort.
        }
        state.Finished = true;
        JsonObject pos = null;
        try
        {
            pos = GameState.Position();
        }
        catch (Exception)
        {
            // Map swap: still answer with the reason and the cells walked.
        }
        var record = _record;
        if (record != null && record.Seq == request.Seq)
        {
            record.Index = index;
            record.Steps = state.Steps;
            record.Cell = state.CurrentCell ?? SafePlayerCell();
            record.Reason = reason;
            record.EndedAt = DateTime.UtcNow.ToString("O");
            record.Active = false;
            // The last index change must not be swallowed by the 100 ms throttle: flush it
            // before walk.end, even if the two progress events end up closer than 100 ms.
            if (index >= 0 && state.Started && index != state.LastProgressIndex)
            {
                state.ProgressPending = true;
            }
            EmitProgress(request, state, Environment.TickCount64, true);
            Emit.Event("walk.end", o =>
            {
                o["walkSeq"] = request.Seq;
                o["reason"] = reason;
                o["index"] = index;
                o["steps"] = state.Steps;
                o["cell"] = CellNode(record.Cell);
            });
        }
        var result = new JsonObject
        {
            ["ok"] = reason == "arrived",
            ["reason"] = reason,
            ["index"] = index,
            ["steps"] = state.Steps,
            ["pos"] = pos,
            ["next"] = next == null ? null : new JsonArray(next[0], next[1]),
            ["turns"] = state.Turns,
        };
        request.Finish(result);
    }

    private static JsonObject Fallback(WalkRequest request)
    {
        // Only when the game thread never answered (it is stuck); there is no fresh pos to give.
        var state = request.State;
        return new JsonObject
        {
            ["ok"] = false,
            ["reason"] = request.Cancel ?? "timeout",
            ["index"] = state.Started && !state.Recovering ? state.Index : -1,
            ["steps"] = state.Steps,
            ["pos"] = null,
            ["next"] = null,
            ["turns"] = new JsonArray(),
        };
    }

    private static bool Open(WebSocket socket)
    {
        if (socket == null)
        {
            return false;
        }
        try
        {
            return socket.State == WebSocketState.Open;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>First game frame of a walkpath: keep the record and push walk.start.</summary>
    private static void Announce(
        WalkRequest request,
        WalkState state,
        int? map,
        int[] cell,
        int initialIndex,
        long now)
    {
        state.Announced = true;
        state.ProgressPending = true;
        state.ProgressLastAt = now - 1000;  // the first progress may go out immediately
        state.LastProgressIndex = -1;
        _record = new WalkRecord
        {
            Seq = request.Seq,
            Map = map,
            Path = request.Path,
            Goal = request.Goal,
            Label = request.Label,
            StartedAt = request.StartedAt,
            Index = initialIndex,
            Steps = state.Steps,
            Cell = cell,
            Turns = state.Turns,
            Active = true,
        };
        Emit.Event("walk.start", o =>
        {
            // walkSeq, not seq: the header's seq is the stream's own counter, which clients use to
            // drop records they already have (dsh events.ts); overriding it lost every walk event.
            o["walkSeq"] = request.Seq;
            o["map"] = map;
            o["path"] = PathNode(request.Path);
            o["goal"] = CellNode(request.Goal);
            o["label"] = request.Label;
        });
    }

    /// <summary>Keep the query record at the walker's current cell/index without emitting.</summary>
    private static void SyncRecord(WalkRequest request, WalkState state)
    {
        var record = _record;
        if (record == null || record.Seq != request.Seq)
        {
            return;
        }
        if (!state.Started)
        {
            // Before the start cell is resolved the walker's Index is not meaningful yet.
            record.Cell = state.CurrentCell;
            return;
        }
        if (state.LastProgressIndex < 0)
        {
            // The first progress may have been skipped while waiting in Gimmick/battle.
            state.ProgressPending = true;
        }
        if (record.Index != state.Index || record.Steps != state.Steps)
        {
            record.Index = state.Index;
            record.Steps = state.Steps;
            state.ProgressPending = true;
        }
        record.Cell = state.CurrentCell;
    }

    /// <summary>
    /// walk.progress on every index change, at most one per 100 ms for the same walkpath.
    /// The pending flag keeps the newest change; Finish forces it out before walk.end.
    /// </summary>
    private static void EmitProgress(WalkRequest request, WalkState state, long now, bool force)
    {
        if (!state.ProgressPending)
        {
            return;
        }
        var record = _record;
        if (record == null || record.Seq != request.Seq)
        {
            state.ProgressPending = false;
            return;
        }
        if (!state.Started || record.Index < 0)
        {
            state.ProgressPending = false;
            return;
        }
        if (!force && now - state.ProgressLastAt < 100)
        {
            return;
        }
        var segment = SegmentOf(record.Path, record.Index);
        if (segment.Of <= 0)
        {
            state.ProgressPending = false;
            return;
        }
        Emit.Event("walk.progress", o =>
        {
            o["walkSeq"] = request.Seq;
            o["index"] = record.Index;
            o["steps"] = record.Steps;
            o["cell"] = CellNode(record.Cell);
            o["segment"] = new JsonObject
            {
                ["n"] = segment.N,
                ["of"] = segment.Of,
            };
        });
        state.ProgressLastAt = now;
        state.LastProgressIndex = record.Index;
        state.ProgressPending = false;
    }

    /// <summary>
    /// Split the path at its corners. The edge index→index+1 belongs to the segment that starts
    /// at the latest corner at or before index; once at the last cell, the last segment is used.
    /// </summary>
    private static (int N, int Of, int[] From, int[] To) SegmentOf(int[][] path, int index)
    {
        if (path == null || path.Length == 0 || index < 0)
        {
            return (0, 0, null, null);
        }
        if (path.Length == 1)
        {
            return (1, 1, path[0], path[0]);
        }
        var starts = new List<int> { 0 };
        for (var e = 1; e < path.Length - 1; e++)
        {
            if (Direction(path[e - 1], path[e]) != Direction(path[e], path[e + 1]))
            {
                starts.Add(e);  // a new straight segment starts at this corner
            }
        }
        var edge = Math.Min(index, path.Length - 2);
        var k = 0;
        for (var s = 1; s < starts.Count; s++)
        {
            if (starts[s] <= edge)
            {
                k = s;
            }
            else
            {
                break;
            }
        }
        var last = path.Length - 1;
        return (k + 1, starts.Count, path[starts[k]], path[k + 1 < starts.Count ? starts[k + 1] : last]);
    }

    private static JsonArray PathNode(int[][] path)
    {
        var array = new JsonArray();
        for (var i = 0; path != null && i < path.Length; i++)
        {
            array.Add(new JsonArray(path[i][0], path[i][1]));
        }
        return array;
    }

    private static JsonArray CellNode(int[] cell) =>
        cell == null ? null : new JsonArray(cell[0], cell[1]);

    private static JsonObject SegmentNode(int[][] path, int index)
    {
        var segment = SegmentOf(path, index);
        if (segment.Of <= 0)
        {
            return null;
        }
        return new JsonObject
        {
            ["n"] = segment.N,
            ["of"] = segment.Of,
            ["from"] = CellNode(segment.From),
            ["to"] = CellNode(segment.To),
        };
    }

    private static int[] SafePlayerCell()
    {
        try
        {
            return GameState.PlayerCell();
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static void AddTurn(
        WalkState state,
        int[] cell,
        Vector3 exact,
        bool ok,
        string mode,
        int? arriveFrame,
        bool moving)
    {
        if (state.Turns.Count >= MaxTurns)
        {
            return;
        }
        state.Turns.Add(new JsonObject
        {
            ["cell"] = new JsonArray(cell[0], cell[1]),
            ["at"] = new JsonArray(Math.Round(exact.x, 2), Math.Round(exact.y, 2)),
            ["frame"] = Probe.Frame,
            ["ok"] = ok,
            // Diagnostics for the 11-08 calibration: which rule switched, when the reading
            // became the corner, and the raw local position that led to it.
            ["mode"] = mode,
            ["arriveFrame"] = arriveFrame,
            ["moving"] = moving,
            ["raw"] = state.HasRawLocal
                ? new JsonArray(Math.Round(state.RawLocal.x, 2), Math.Round(state.RawLocal.y, 2))
                : null,
        });
    }

    /// <summary>The rounded cell just became a corner: fill arriveFrame on its turn entry.</summary>
    private static void MarkTurnArrived(WalkState state, int[] cell, int frame)
    {
        for (var i = state.Turns.Count - 1; i >= 0; i--)
        {
            if (state.Turns[i] is JsonObject turn &&
                turn["cell"] is JsonArray at && at.Count == 2 &&
                at[0]?.GetValue<int>() == cell[0] && at[1]?.GetValue<int>() == cell[1] &&
                turn["arriveFrame"] == null)
            {
                turn["arriveFrame"] = frame;
                return;
            }
        }
    }

    /// <summary>The player stopped on a corner: fill stopFrame on its turn entry, once.</summary>
    private static void MarkTurnStopped(WalkState state, int[] cell, int frame)
    {
        for (var i = state.Turns.Count - 1; i >= 0; i--)
        {
            if (state.Turns[i] is JsonObject turn &&
                turn["cell"] is JsonArray at && at.Count == 2 &&
                at[0]?.GetValue<int>() == cell[0] && at[1]?.GetValue<int>() == cell[1] &&
                turn["stopFrame"] == null)
            {
                turn["stopFrame"] = frame;
                return;
            }
        }
    }

    /// <summary>An overshoot happened at this corner: correct the turn entry we already wrote.</summary>
    private static void MarkTurnBad(WalkState state, int[] cell, Vector3 exact, bool moving)
    {
        for (var i = state.Turns.Count - 1; i >= 0; i--)
        {
            if (state.Turns[i] is JsonObject turn &&
                turn["cell"] is JsonArray at && at.Count == 2 &&
                at[0]?.GetValue<int>() == cell[0] && at[1]?.GetValue<int>() == cell[1])
            {
                turn["ok"] = false;
                return;
            }
        }
        AddTurn(state, cell, exact, false, state.SawFraction ? "lead" : "flip", null, moving);
    }

    private static int[][] ParsePath(JsonNode node)
    {
        var array = node as JsonArray;
        if (array == null || array.Count == 0)
        {
            return null;
        }
        var path = new int[array.Count][];
        for (var i = 0; i < array.Count; i++)
        {
            var cell = array[i] as JsonArray;
            if (cell == null || cell.Count != 2)
            {
                return null;
            }
            try
            {
                path[i] = new[] { cell[0].GetValue<int>(), cell[1].GetValue<int>() };
            }
            catch (Exception)
            {
                return null;
            }
        }
        return path;
    }

    private static bool Adjacent(int[][] path)
    {
        if (path == null || path.Length == 0)
        {
            return false;
        }
        for (var i = 1; i < path.Length; i++)
        {
            if (Math.Abs(path[i][0] - path[i - 1][0]) + Math.Abs(path[i][1] - path[i - 1][1]) != 1)
            {
                return false;
            }
        }
        return true;
    }

    /// <summary>Optional display-only goal; a malformed one is ignored, never fails the walk.</summary>
    private static int[] ParsePoint(JsonNode node)
    {
        var array = node as JsonArray;
        if (array == null || array.Count != 2)
        {
            return null;
        }
        try
        {
            return new[] { array[0].GetValue<int>(), array[1].GetValue<int>() };
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>Optional display-only label, cut to 80 characters.</summary>
    private static string ParseLabel(JsonNode node)
    {
        if (node == null)
        {
            return null;
        }
        try
        {
            var label = node.GetValue<string>();
            return label != null && label.Length > 80 ? label.Substring(0, 80) : label;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static int ClampInt(JsonNode node, int fallback, int min, int max)
    {
        if (node == null)
        {
            return fallback;
        }
        try
        {
            return Math.Clamp(node.GetValue<int>(), min, max);
        }
        catch (Exception)
        {
            return fallback;
        }
    }

    private static float ClampFloat(JsonNode node, float fallback, float min, float max)
    {
        if (node == null)
        {
            return fallback;
        }
        try
        {
            return Math.Clamp(node.GetValue<float>(), min, max);
        }
        catch (Exception)
        {
            return fallback;
        }
    }

    private static int[] RoundCell(Vector3 cell) =>
        new[] { (int)Math.Round(cell.x), (int)Math.Round(cell.y) };

    private static bool Same(int[] a, int[] b) => a[0] == b[0] && a[1] == b[1];

    private static int FindCell(int[][] path, int[] cell)
    {
        for (var i = 0; i < path.Length; i++)
        {
            if (Same(path[i], cell))
            {
                return i;
            }
        }
        return -1;
    }

    /// <summary>
    /// A route can visit the same cell twice. For resyncing, prefer the first occurrence at or
    /// after `from` (progress forward); only fall back to an earlier one.
    /// </summary>
    private static int FindCellFrom(int[][] path, int[] cell, int from)
    {
        var before = -1;
        for (var i = 0; i < path.Length; i++)
        {
            if (!Same(path[i], cell))
            {
                continue;
            }
            if (i >= from)
            {
                return i;
            }
            before = i;
        }
        return before;
    }

    /// <summary>
    /// The route cell next to <paramref name="cell"/> that is closest to where we were heading.
    /// An overshoot past a corner lands one cell beyond the corner, so this is usually the corner.
    /// </summary>
    private static int AdjacentIndex(int[][] path, int[] cell, int near)
    {
        var best = -1;
        var bestScore = int.MaxValue;
        for (var i = 0; i < path.Length; i++)
        {
            if (Math.Abs(path[i][0] - cell[0]) + Math.Abs(path[i][1] - cell[1]) != 1)
            {
                continue;
            }
            var score = Math.Abs(i - (near + 1));
            if (score < bestScore)
            {
                bestScore = score;
                best = i;
            }
        }
        return best;
    }

    private static string Direction(int[] from, int[] to)
    {
        if (to[0] > from[0])
        {
            return "Right";
        }
        if (to[0] < from[0])
        {
            return "Left";
        }
        return to[1] > from[1] ? "Down" : "Up";
    }

    private static float Distance(Vector3 exact, int[] cell)
    {
        var dx = exact.x - cell[0];
        var dy = exact.y - cell[1];
        return Mathf.Sqrt(dx * dx + dy * dy);
    }

    /// <summary>World-map readings are whole cells; indoor/fractional maps are not.</summary>
    private static bool IsFractional(Vector3 exact) =>
        Mathf.Abs(exact.x - Mathf.Round(exact.x)) > 0.01f ||
        Mathf.Abs(exact.y - Mathf.Round(exact.y)) > 0.01f;
}
