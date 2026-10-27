using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using Il2CppInterop.Runtime;
using Last.Battle;
using Last.Management;
using Last.Message;
using UnityEngine;
using Singleton = Il2CppSystem.SingletonMonoBehaviour<Last.Message.MessageWindowManager>;

namespace FfprBridge;

/// <summary>The map and the player on it: cells, terrain, entities, collision, routes.</summary>
internal static partial class GameState
{
    private static FieldMap _fieldMap;
    private static float _nextFieldSearch;

    /// <summary>The map's controller and the player on it, or false when not on a map.</summary>
    public static bool TryPlayer(out Last.Map.FieldController controller, out Last.Entity.Field.FieldPlayer player)
    {
        // FieldMap only exists on maps; look for it at most once a second when it is gone.
        if (_fieldMap == null && Time.unscaledTime >= _nextFieldSearch)
        {
            _nextFieldSearch = Time.unscaledTime + 1f;
            _fieldMap = UnityEngine.Object.FindObjectOfType(Il2CppType.Of<FieldMap>())?.TryCast<FieldMap>();
        }
        controller = _fieldMap == null ? null : _fieldMap.fieldController;
        player = controller?.player;
        return player != null;
    }

    /// <summary>The player's cell (x grows to the right, y grows downwards), or null.</summary>
    public static int[] PlayerCell()
    {
        if (!TryPlayer(out var controller, out var player))
        {
            return null;
        }
        try
        {
            var cell = controller.ConvertWorldPositionToCellPosition(player.transform.localPosition);
            return new[] { (int)Math.Round(cell.x), (int)Math.Round(cell.y) };
        }
        catch (Exception)
        {
            // Throws while a map is being swapped in.
            return null;
        }
    }

    /// <summary>Facing as Up/Down/Left/Right, from the entity's direction vector.</summary>
    public static string Facing(Last.Entity.Field.FieldPlayer player)
    {
        var d = player.directionVector;
        if (d.x == 0f && d.y == 0f)
        {
            return null;
        }
        return Math.Abs(d.x) >= Math.Abs(d.y) ? (d.x > 0 ? "Right" : "Left") : (d.y > 0 ? "Up" : "Down");
    }

    private static JsonNode Field()
    {
        if (!TryPlayer(out var controller, out var player))
        {
            return null;
        }
        var local = player.transform.localPosition;
        var o = new JsonObject
        {
            ["pos"] = Vec(local),
            ["entity"] = Vec(player.GetEntityPosition()),
            ["dirVec"] = Vec(player.directionVector),
            ["dir"] = Facing(player),
            ["moving"] = player.IsMoving,
            ["moveState"] = player.moveState.ToString(),
        };
        var cell = PlayerCell();
        o["cell"] = cell == null ? null : new JsonArray(cell[0], cell[1]);
        return o;
    }

    /// <summary>
    /// The map's cell attributes in a square around the player. What the bits mean is not known
    /// yet; P0b compares them with where the player could and could not walk.
    /// </summary>
    public static JsonObject Cells(int radius)
    {
        var center = PlayerCell();
        if (center == null || !TryPlayer(out var controller, out _))
        {
            return null;
        }
        var rows = new JsonArray();
        for (var y = center[1] - radius; y <= center[1] + radius; y++)
        {
            var row = new JsonArray();
            for (var x = center[0] - radius; x <= center[0] + radius; x++)
            {
                int? attr;
                try
                {
                    attr = controller.GetCellAttribute(new Vector2(x, y));
                }
                catch (Exception)
                {
                    attr = null;
                }
                row.Add(attr);
            }
            rows.Add(row);
        }
        return new JsonObject
        {
            ["center"] = new JsonArray(center[0], center[1]),
            ["origin"] = new JsonArray(center[0] - radius, center[1] - radius),
            ["attr"] = rows,
        };
    }

    /// <summary>
    /// The current map's entities: entrances with their destination map, chests with their
    /// contents, NPCs and events, each with its cell. `kind` filters on the property class name
    /// (GotoMap, TresureBox, Npc, Event ...).
    /// </summary>
    public static JsonObject Entities(int max, string kind)
    {
        if (!TryPlayer(out var controller, out _))
        {
            return null;
        }
        var list = controller.entityList;
        var found = new JsonArray();
        for (var i = 0; list != null && i < list.Count && found.Count < max; i++)
        {
            var entity = list[i];
            var p = entity?.Property;
            if (p == null)
            {
                continue;
            }
            var type = p.GetIl2CppType().Name;
            if (!string.IsNullOrEmpty(kind) && !type.Contains(kind, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            var o = new JsonObject
            {
                ["kind"] = type.StartsWith("Property", StringComparison.Ordinal) ? type[8..] : type,
                ["id"] = p.EntityId,
                ["name"] = p.Name,
                ["tile"] = Vec(p.TilePosition),
                ["active"] = entity.gameObject.activeInHierarchy,
            };
            try
            {
                var cell = controller.ConvertWorldPositionToCellPosition(entity.transform.localPosition);
                o["cell"] = new JsonArray((int)Math.Round(cell.x), (int)Math.Round(cell.y));
            }
            catch (Exception)
            {
                o["cell"] = null;
            }
            var gotoMap = p.TryCast<Last.Map.PropertyGotoMap>();
            if (gotoMap != null)
            {
                o["toMap"] = gotoMap.MapId;
                o["point"] = gotoMap.PointId;
            }
            var chest = p.TryCast<Last.Map.PropertyTresureBox>();
            if (chest != null)
            {
                o["content"] = chest.ContentId;
                o["num"] = chest.ContentNum;
                o["flag"] = chest.FlagId;
            }
            var npc = p.TryCast<Last.Map.PropertyNpc>();
            if (npc != null)
            {
                o["npc"] = npc.NpcId;
            }
            var ev = p.TryCast<Last.Map.PropertyEvent>();
            if (ev != null && gotoMap == null)
            {
                o["script"] = ev.ScriptId;
            }
            found.Add(o);
        }
        return new JsonObject { ["total"] = list?.Count ?? 0, ["entities"] = found };
    }

    /// <summary>
    /// The game's own route from the player to a cell (MapRouteSearcher, the touch-to-move
    /// pathfinder), honouring collisions. A pure computation over the map's collision data;
    /// nothing moves. Tries the searcher's entity-based entry point and its plain one, from
    /// both its own idea of the start cell and ours, and reports what each returned: the first
    /// version returned nothing at all, so the coordinate convention is still being pinned down.
    /// </summary>
    public static JsonObject Route(int x, int y, bool collision)
    {
        if (!TryPlayer(out var controller, out var player))
        {
            return null;
        }
        var accessor = new Last.Map.IMapAccessor(controller.Pointer);
        var ours = controller.ConvertWorldPositionToCellPosition(player.transform.localPosition);
        var theirs = MapRouteSearcher.EntityWorldPositionToCellPosition(accessor, player);
        var tries = new JsonObject();
        JsonArray best = null;

        void Attempt(string name, Func<Il2CppSystem.Collections.Generic.List<Vector3>> search)
        {
            try
            {
                var found = search();
                var cells = new JsonArray();
                for (var i = 0; found != null && i < found.Count; i++)
                {
                    cells.Add(new JsonArray(Round(found[i].x), Round(found[i].y), Round(found[i].z)));
                }
                tries[name] = cells.Count;
                if (best == null && cells.Count > 0 && name != "entity")
                {
                    best = cells;
                    tries["used"] = name;
                }
            }
            catch (Exception e)
            {
                tries[name] = $"{e.GetType().Name}: {e.Message}";
            }
        }

        // Order matters: "theirs" and "simple" return cells; "entity" returns local positions
        // in pixels and is only kept for comparison. Our own start cell carries layer 0 where
        // the searcher expects its layer (1 in the Wind Shrine), so "ours" finds nothing.
        Attempt("theirs", () => MapRouteSearcher.Search(accessor, theirs, new Vector3(x, y, theirs.z), collision));
        Attempt("simple", () => MapRouteSearcher.SearchSimple(accessor, theirs, new Vector3(x, y, theirs.z)));
        // 0.6.7: the goal may be on another height (Carwen's shops stand on the upper level,
        // the street below, 10-20): try the goal on each layer the searcher knows.
        for (var z = 0; z <= 2; z++)
        {
            if (best != null)
            {
                break;
            }
            var layer = z;
            if (layer == (int)Math.Round(theirs.z))
            {
                continue;
            }
            Attempt($"theirs@{layer}", () => MapRouteSearcher.Search(accessor, theirs, new Vector3(x, y, layer), collision));
            Attempt($"simple@{layer}", () => MapRouteSearcher.SearchSimple(accessor, theirs, new Vector3(x, y, layer)));
        }
        Attempt("ours", () => MapRouteSearcher.Search(
            accessor, new Vector3(Mathf.Round(ours.x), Mathf.Round(ours.y), ours.z),
            new Vector3(x, y, ours.z), collision));
        Attempt("entity", () => MapRouteSearcher.SearchSpriteEntityToCellPosition(
            accessor, player, new Vector3(x, y, theirs.z)));

        return new JsonObject
        {
            ["from"] = new JsonArray((int)Math.Round(ours.x), (int)Math.Round(ours.y)),
            ["theirs"] = Vec(theirs),
            ["ours"] = Vec(ours),
            ["cells"] = best ?? new JsonArray(),
            ["tries"] = tries,
            ["limit"] = new JsonArray(MapRouteSearcher.SearchHorizontalLimit, MapRouteSearcher.SearchVerticalLimit),
        };
    }

    /// <summary>
    /// The map's collision grid (Tiled data the game loads with the map): one string per row
    /// per layer, one character per cell: its value (0 open, 1 blocked, others e.g. stairs). Also the layer the route searcher puts the
    /// player on, so the dev box can search the right one. Read-only.
    /// </summary>
    public static JsonObject Collision()
    {
        if (!TryPlayer(out var controller, out var player))
        {
            return null;
        }
        var group = controller.mapManager?.currentMapModel?.AssetData?.CollsionInfo?.CollisionMap;
        if (group == null)
        {
            return new JsonObject { ["error"] = "这张地图没有碰撞数据" };
        }
        var accessor = new Last.Map.IMapAccessor(controller.Pointer);
        var theirs = MapRouteSearcher.EntityWorldPositionToCellPosition(accessor, player);
        var layers = new JsonArray();
        for (var i = 0; group.layers != null && i < group.layers.Length; i++)
        {
            var layer = group.layers[i];
            var data = layer.data;
            var width = layer.width;
            var height = layer.height;
            var rows = new JsonArray();
            var values = new SortedSet<int>();
            for (var y = 0; data != null && y < height; y++)
            {
                var row = new char[width];
                for (var x = 0; x < width; x++)
                {
                    var v = data[y * width + x];
                    values.Add(v);
                    // 0.6.4: the value itself (0-9, then a-z), no longer folded to 0/1: the
                    // stairs inside a map (3, 5 in the Ship Graveyard, 10-20) read as walls.
                    row[x] = v >= 0 && v < 10 ? (char)('0' + v) : v < 36 ? (char)('a' + v - 10) : '#';
                }
                rows.Add(new string(row));
            }
            var distinct = new JsonArray();
            foreach (var v in values)
            {
                if (distinct.Count < 16)
                {
                    distinct.Add(v);
                }
            }
            layers.Add(new JsonObject
            {
                ["index"] = i,
                ["id"] = layer.id,
                ["name"] = layer.name,
                ["width"] = width,
                ["height"] = height,
                ["values"] = distinct,
                ["rows"] = rows,
            });
        }
        var cell = PlayerCell();
        return new JsonObject
        {
            ["name"] = group.name,
            ["width"] = group.width,
            ["height"] = group.height,
            ["playerCell"] = cell == null ? null : new JsonArray(cell[0], cell[1]),
            ["searchLayer"] = theirs.z,
            ["layers"] = layers,
        };
    }

    /// <summary>A small, cheap snapshot for closed-loop walking.</summary>
    public static JsonObject Position()
    {
        var o = new JsonObject
        {
            ["map"] = UserDataManager.instance?.CurrentMapId,
            ["state"] = MainState(),
        };
        if (TryPlayer(out _, out var player))
        {
            var cell = PlayerCell();
            o["cell"] = cell == null ? null : new JsonArray(cell[0], cell[1]);
            o["dir"] = Facing(player);
            o["moving"] = player.IsMoving;
        }
        var dialog = Singleton.instance;
        o["dialog"] = dialog != null && dialog.IsOpen();
        o["battle"] = BattlePlugManager.instance?.isBattle ?? false;
        o["saves"] = UserDataManager.instance?.SaveCompleteCount;
        return o;
    }
}
