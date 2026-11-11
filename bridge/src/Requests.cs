using System;
using System.IO;
using System.Linq;
using System.Net.WebSockets;
using BepInEx;
using System.Text.Json;
using System.Text.Json.Nodes;
using Last.Management;

namespace FfprBridge;

/// <summary>
/// Answers client queries on the game thread. Queries only read, like everything else in the
/// bridge:
///   {"id": 1, "op": "pos"}              map, cell, facing, moving, dialog/battle flags
///   {"id": 2, "op": "cells", "r": 8, "at": [x, y]}  cell attributes around the player or at
///   {"id": 3, "op": "sample"}           the full once-a-second snapshot, now
///   {"id": 4, "op": "entities", "kind": "GotoMap", "max": 200}   entrances, chests, NPCs ...
///   {"id": 5, "op": "route", "to": [x, y]}   the game's own collision-aware route to a cell
///   {"id": 6, "op": "collision"}        the map's collision grid, one string per row per layer
///   {"id": 7, "op": "items"}            normal and key items with counts
///   {"id": 8, "op": "saveui"}           the save/load list: open?, highlighted slot id
///   {"id": 9, "op": "battlemenu"}       whose turn, the command list and cursor, open magic list
///   {"id": 10, "op": "shop"}            shop command menu, products with prices, cursors, quantity
///   {"id": 11, "op": "menu"}            field menu: commands, sub-menu, magic/item/equip lists, targets
///   {"id": 12, "op": "title"}           title menu: commands (greyed out or not), cursor
///   {"id": 13, "op": "shot"}            save this frame as a PNG; the reply names the file
///   {"id": 14, "op": "textinput"}       text fields on screen (naming boxes): text, focused
///   {"id": 15, "op": "bridge"}          this build, its clients, hooks, recent keys and warnings
///   {"id": 16, "op": "monsterai", "ids": [12, 13]}   FF5: AI script and named abilities
///   {"op": "encountgrid", "cells": [[x, y], ...]}    encounter grid number per cell (0.13.8)
///   {"op": "walk"}                     current or last walkpath route and progress (0.14.0)
///   {"op": "config"}                   saved game settings and the current auto-battle switch (0.14.2)
///   {"op": "gameover"}                 FF5: game-over / return-to-title prompt and autosave row (0.14.3)
///   {"op": "bluemagic"}                FF5: learned blue magic and every blue spell (0.14.4)
///   {"op": "monstermoves", "ids": [...]}  FF5: each monster's moves, blue magic and statuses (0.14.4)
///   {"op": "export", "table": "monsters", "offset": 0, "limit": 200}  FF5: whole-game static tables (0.14.5)
///   {"op": "mapinfo"}                  FF5: MapManager package state and the current Map row (0.14.6)
///   {"op": "mappackage", "map": 23}    FF5: read-only map package manifest (0.14.6)
///   {"op": "mapasset", "map": 23, "asset": "collision", "offset": 0, "limit": 20000}
///                                      FF5: one map text asset, paginated (0.14.6)
///   {"op": "treasureflags"}            every master TreasureBox flag: true/false/null (0.14.8)
///   {"op": "vehicles"}                 FF5: where each owned vehicle is parked (0.14.9)
/// </summary>
internal static class Requests
{
    private const int PerFrame = 8;

#if FF5
    private sealed class Pending
    {
        public WebSocket From;
        public string Op;
        public JsonObject Base;
        public MapJob Job;
        public long Deadline;
    }

    // Only one package/asset load at a time: Addressables and the map loaders are not reentrant.
    private static Pending _pending;
#endif

    public static void Drain()
    {
        for (var i = 0; i < PerFrame && Plugin.Outbox.Requests.TryDequeue(out var request); i++)
        {
            var answer = Answer(request.Text, request.From);
            // A map load is deferred: Answer has stored the request and replies from Tick.
            if (answer != null)
            {
                Plugin.Outbox.Reply(request.From, answer);
            }
        }
    }

    /// <summary>
    /// Runs one frame of a deferred map load. Called on the game thread before Drain. When the
    /// loader finishes or the caller's timeout expires, the stored request is answered here.
    /// </summary>
    public static void Tick()
    {
#if FF5
        var pending = _pending;
        if (pending == null)
        {
            return;
        }
        var done = false;
        try
        {
            done = pending.Job.Poll();
        }
        catch (Exception e)
        {
            var failed = pending.Base;
            failed["frame"] = Probe.Frame;
            failed["ok"] = false;
            failed["error"] = $"{e.GetType().Name}: {e.Message}";
            _pending = null;
            try
            {
                pending.Job.Close();
            }
            catch (Exception)
            {
            }
            Plugin.Outbox.Reply(pending.From, Emit.Serialize(failed));
            return;
        }
        if (!done && Environment.TickCount64 < pending.Deadline)
        {
            return;
        }
        var reply = pending.Base;
        reply["frame"] = Probe.Frame;
        try
        {
            var result = pending.Job.Result(!done);
            reply[pending.Op] = result;
            var error = result["error"]?.GetValue<string>();
            reply["ok"] = string.IsNullOrEmpty(error);
            if (!string.IsNullOrEmpty(error))
            {
                reply["error"] = error;
            }
        }
        catch (Exception e)
        {
            reply["ok"] = false;
            reply["error"] = $"{e.GetType().Name}: {e.Message}";
        }
        finally
        {
            _pending = null;
            try
            {
                pending.Job.Close();
            }
            catch (Exception)
            {
            }
        }
        Plugin.Outbox.Reply(pending.From, Emit.Serialize(reply));
#endif
    }

    private static string Answer(string text, WebSocket from)
    {
        var reply = new JsonObject { ["type"] = "reply", ["frame"] = Probe.Frame };
        try
        {
            var query = JsonNode.Parse(text)?.AsObject() ?? throw new JsonException("空请求");
            // A node can have one parent; .NET 6 has no DeepClone, so copy it by re-parsing.
            var id = query["id"];
            reply["re"] = id == null ? null : JsonNode.Parse(id.ToJsonString());
            var op = query["op"]?.GetValue<string>();
            reply["op"] = op;
            switch (op)
            {
                case "pos":
                    reply["pos"] = GameState.Position();
                    break;
                case "cells":
                    var radius = Math.Clamp(query["r"]?.GetValue<int>() ?? 8, 1, 24);
                    reply["cells"] = GameState.Cells(radius, Point(query["at"], "at"));
                    break;
                case "entities":
                    var max = Math.Clamp(query["max"]?.GetValue<int>() ?? 200, 1, 1000);
                    reply["entities"] = GameState.Entities(max, query["kind"]?.GetValue<string>());
                    break;
                case "route":
                    var to = query["to"]?.AsArray() ?? throw new ArgumentException("route 需要 to");
                    var collision = query["collision"]?.GetValue<bool>() ?? true;
                    reply["route"] = GameState.Route(to[0].GetValue<int>(), to[1].GetValue<int>(), collision);
                    break;
                case "items":
                    reply["items"] = GameState.Items();
                    break;
                case "bestiary":
                    reply["bestiary"] = GameState.Bestiary();
                    break;
                case "achievements":
                    reply["achievements"] = GameState.Achievements();
                    break;
                case "treasureflags":
                    reply["treasureflags"] = GameState.TreasureFlags();
                    break;
                case "vehicles":
#if FF5
                    reply["vehicles"] = GameState.Vehicles();
                    break;
#else
                    throw new ArgumentException("vehicles 目前只在 FF5 里有");
#endif
                case "monsters":
                    reply["monsters"] = GameState.Monsters();
                    break;
                case "battlemenu":
                    reply["battlemenu"] = GameState.BattleMenu();
                    break;
                case "shop":
                    reply["shop"] = GameState.Shop();
                    break;
                case "menu":
                    reply["menu"] = GameState.Menu();
                    break;
                case "saveui":
                    reply["saveui"] = GameState.SaveUi();
                    break;
                case "title":
                    reply["title"] = GameState.Title();
                    break;
                case "shot":
                    reply["shot"] = Shot();
                    break;
                case "textinput":
                    reply["textinput"] = GameState.TextInput();
                    break;
                case "bridge":
                    reply["bridge"] = BridgeInfo.Snapshot();
                    break;
                case "encounters":
                    reply["encounters"] = GameState.Encounters();
                    break;
                case "encountgrid":
                    var encountCells = query["cells"]?.AsArray() ??
                        throw new ArgumentException("encountgrid 需要 cells");
                    reply["encountgrid"] = GameState.EncountGrids(encountCells);
                    break;
                case "walk":
                    reply["walk"] = Walker.Snapshot();
                    break;
                case "config":
                    // Set null first: a failed read must still answer {"config": null, "error": ...}.
                    reply["config"] = null;
                    reply["config"] = GameState.Config();
                    break;
                case "gameover":
#if FF5
                    reply["gameover"] = GameState.GameOver();
                    break;
#else
                    throw new ArgumentException("gameover 目前只在 FF5 里有");
#endif
                case "monsterai":
#if FF5
                    reply["monsterai"] = GameState.MonsterAi(MonsterIds(query));
                    break;
#else
                    throw new ArgumentException("monsterai 目前只在 FF5 里有");
#endif
                case "bluemagic":
#if FF5
                    reply["bluemagic"] = GameState.BlueMagic();
                    break;
#else
                    throw new ArgumentException("bluemagic 目前只在 FF5 里有");
#endif
                case "monstermoves":
#if FF5
                    reply["monstermoves"] = GameState.MonsterMoves(MonsterIds(query));
                    break;
#else
                    throw new ArgumentException("monstermoves 目前只在 FF5 里有");
#endif
                case "export":
#if FF5
                    reply["export"] = GameState.Export(
                        query["table"]?.GetValue<string>(),
                        query["offset"]?.GetValue<int>() ?? 0,
                        query["limit"]?.GetValue<int>() ?? 200);
                    break;
#else
                    throw new ArgumentException("export 目前只在 FF5 里有");
#endif
                case "mapinfo":
#if FF5
                    reply["mapinfo"] = GameState.MapInfo();
                    break;
#else
                    throw new ArgumentException("mapinfo 目前只在 FF5 里有");
#endif
                case "mappackage":
                case "mapasset":
#if FF5
                    if (_pending != null)
                    {
                        throw new InvalidOperationException($"忙:{_pending.Op} 还在加载，稍后再试");
                    }
                    var job = GameState.StartMapJob(op, query);
                    _pending = new Pending
                    {
                        From = from,
                        Op = op,
                        Base = reply,
                        Job = job,
                        Deadline = Environment.TickCount64 + job.TimeoutMs,
                    };
                    // No reply this frame; Tick answers when the loader is done or times out.
                    return null;
#else
                    throw new ArgumentException($"{op} 目前只在 FF5 里有");
#endif
                case "collision":
                    reply["collision"] = GameState.Collision();
                    break;
                case "sample":
                    var sample = new JsonObject();
                    GameState.Fill(sample);
                    reply["sample"] = sample;
                    break;
                default:
                    throw new ArgumentException($"未知的 op:{op}");
            }
            reply["ok"] = true;
        }
        catch (Exception e)
        {
            reply["ok"] = false;
            reply["error"] = $"{e.GetType().Name}: {e.Message}";
        }
        return Emit.Serialize(reply);
    }

    /// <summary>An optional [x, y] from a query (0.14.0: cells' at); null when absent.</summary>
    private static int[] Point(JsonNode node, string name)
    {
        if (node == null)
        {
            return null;
        }
        var array = node as JsonArray ?? throw new ArgumentException($"{name} 需要 [x, y]");
        if (array.Count != 2)
        {
            throw new ArgumentException($"{name} 需要 [x, y]");
        }
        return new[] { array[0].GetValue<int>(), array[1].GetValue<int>() };
    }

    /// <summary>
    /// monsterai: one id, a list, a comma-separated string, or no id for this battle. If "ids"
    /// is present it is the only source; adding "id" as well made a third, unrequested row.
    /// </summary>
    private static int[] MonsterIds(JsonObject query)
    {
        var ids = new System.Collections.Generic.List<int>();
        void AddId(int id)
        {
            if (id > 0 && !ids.Contains(id))
            {
                ids.Add(id);
            }
        }
        void Take(JsonNode node)
        {
            if (node == null)
            {
                return;
            }
            if (node is JsonArray array)
            {
                foreach (var item in array)
                {
                    Take(item);
                }
                return;
            }
            if (!(node is JsonValue))
            {
                return;
            }
            try
            {
                AddId(node.GetValue<int>());
                return;
            }
            catch (Exception)
            {
            }
            try
            {
                var text = node.GetValue<string>();
                foreach (var part in text.Split(new[] { ',', ' ' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    if (int.TryParse(part, out var parsed))
                    {
                        AddId(parsed);
                    }
                }
            }
            catch (Exception)
            {
            }
        }
        var list = query["ids"];
        if (list != null)
        {
            Take(list);
        }
        else
        {
            Take(query["id"]);
        }
        return ids.Count == 0 ? null : ids.ToArray();
    }

    /// <summary>
    /// 10-28: six games run minimized at once, and the pilot agent's screenshot has to bring a
    /// window to the front. Unity writes the frame itself at the end of this frame; the reply
    /// only names the file under BepInEx\ffpr\shots (read it over SSH a moment later).
    /// </summary>
    private static JsonObject Shot()
    {
        var dir = Path.Combine(Paths.BepInExRootPath, "ffpr", "shots");
        Directory.CreateDirectory(dir);
        foreach (var old in new DirectoryInfo(dir).GetFiles("*.png"))
        {
            if (old.CreationTimeUtc < DateTime.UtcNow.AddHours(-1))
            {
                old.Delete();
            }
        }
        var file = Path.Combine(dir, $"shot-{DateTime.Now:yyyyMMdd-HHmmss-fff}.png");
        UnityEngine.ScreenCapture.CaptureScreenshot(file);
        return new JsonObject { ["file"] = file };
    }
}

/// <summary>
/// Reports each map change with the cell the player left from and the cell they arrived at,
/// which is what a map graph needs. Checked every frame because at dash speed the once-a-second
/// sample usually misses the exit cell.
/// </summary>
internal static class MapWatch
{
    private const int CellEvery = 4;

    private static int? _map;
    private static int[] _lastCell;
    private static int? _fromMap;
    private static int[] _fromCell;
    private static int _frames;

    public static void Update()
    {
        var map = UserDataManager.instance?.CurrentMapId;
        if (map == null)
        {
            return;
        }
        if (map != _map)
        {
            GameState.InvalidateEncountCache();
            if (_map != null)
            {
                _fromMap = _map;
                _fromCell = _lastCell;
            }
            _map = map;
            _lastCell = null;
        }
        // The cell costs a few calls into the game; every fourth frame is enough while walking,
        // but right after a change keep looking until the new map has a player.
        if (_fromMap == null && ++_frames % CellEvery != 0)
        {
            return;
        }
        var cell = GameState.PlayerCell();
        if (cell == null)
        {
            return;
        }
        if (_fromMap != null)
        {
            var from = _fromMap;
            var fromCell = _fromCell;
            Emit.Event("map.change", o =>
            {
                o["from"] = from;
                o["fromCell"] = fromCell == null ? null : new JsonArray(fromCell[0], fromCell[1]);
                o["to"] = map;
                o["toCell"] = new JsonArray(cell[0], cell[1]);
                o["state"] = GameState.MainState();
            });
            _fromMap = null;
        }
        _lastCell = cell;
    }
}

/// <summary>
/// Pushes "pos.change" whenever the position record changes: map, cell, facing, moving, main
/// state, dialog, battle or the save counter. Stream clients then see each step and each state
/// change within a few frames, instead of polling (control plan §5).
/// </summary>
internal static class PosWatch
{
    private const int Every = 4;

    private static string _last;
    private static int _frames;

    public static void Update()
    {
        if (++_frames % Every != 0)
        {
            return;
        }
        var pos = GameState.Position();
        var text = pos.ToJsonString();
        if (text == _last)
        {
            return;
        }
        _last = text;
        Emit.Event("pos.change", o =>
        {
            foreach (var (key, value) in pos.ToArray())
            {
                pos.Remove(key);
                o[key] = value;
            }
        });
    }
}
