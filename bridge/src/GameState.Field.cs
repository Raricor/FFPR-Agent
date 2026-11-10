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

    /// <summary>
    /// The player's fractional cell position (x grows to the right, y grows downwards) and its
    /// layer in z. 0.14.0: walkpath needs the sub-cell position to time corner turns; PlayerCell
    /// still rounds it for everything else.
    /// </summary>
    public static bool TryPlayerCellExact(out Vector3 cell)
    {
        cell = default;
        if (!TryPlayer(out var controller, out var player))
        {
            return false;
        }
        try
        {
            cell = controller.ConvertWorldPositionToCellPosition(player.transform.localPosition);
            return true;
        }
        catch (Exception)
        {
            // Throws while a map is being swapped in.
            return false;
        }
    }

    /// <summary>The player's cell (x grows to the right, y grows downwards), or null.</summary>
    public static int[] PlayerCell()
    {
        if (!TryPlayerCellExact(out var cell))
        {
            return null;
        }
        return new[] { (int)Math.Round(cell.x), (int)Math.Round(cell.y) };
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
    /// The map's cell attributes in a square of `radius` around `at` (0.14.0), or around the
    /// player when `at` is null. What the bits mean is not known yet; P0b compares them with
    /// where the player could and could not walk. `center` stays the player's cell so a client
    /// can tell where the party is; `origin` is the window's top-left cell.
    /// </summary>
    public static JsonObject Cells(int radius, int[] at = null)
    {
        var center = PlayerCell();
        if (center == null || !TryPlayer(out var controller, out _))
        {
            return null;
        }
        var read = at ?? center;
        var rows = new JsonArray();
        for (var y = read[1] - radius; y <= read[1] + radius; y++)
        {
            var row = new JsonArray();
            for (var x = read[0] - radius; x <= read[0] + radius; x++)
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
            ["at"] = new JsonArray(read[0], read[1]),
            ["origin"] = new JsonArray(read[0] - radius, read[1] - radius),
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
        if (string.Equals(kind, "All", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(kind, "*", StringComparison.Ordinal))
        {
            return AllEntities(max);
        }
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
                AddChestFields(o, chest);
            }
            var npc = p.TryCast<Last.Map.PropertyNpc>();
            if (npc != null)
            {
                o["npc"] = npc.NpcId;
            }
            // 0.13.4: map gimmicks. A ToLayer names its target layer; an OpenTrigger is a
            // box the party walks into and links (LinkObjectId) to the TileAnimRegion door
            // it opens; a PointIn marks where a map or script puts the party.
            var toLayer = p.TryCast<Last.Map.PropertyToLayer>();
            if (toLayer != null)
            {
                o["layer"] = toLayer.Layer;
                o["changeLayer"] = toLayer.GetLayerType().ToString();
            }
            var pointIn = p.TryCast<Last.Map.PropertyPointIn>();
            if (pointIn != null)
            {
                o["linkObjectId"] = pointIn.LinkObjectId;
                o["titleId"] = pointIn.TitleId;
                o["titleType"] = pointIn.TitleType;
            }
            var tile = p.TryCast<Last.Map.PropertyTileAnimRegion>();
            if (tile != null)
            {
                o["isReverse"] = tile.IsReverse;
                var anim = entity.TryCast<Last.Entity.Field.FieldTileAnimRegionEntity>();
                if (anim != null)
                {
                    o["isPlaying"] = anim.IsPlaying;
                }
            }
            var ev = p.TryCast<Last.Map.PropertyEvent>();
            if (ev != null)
            {
                o["script"] = ev.ScriptId;
                o["linkObjectId"] = ev.LinkObjectId;
                o["actionId"] = ev.ActionId;
                if (!string.IsNullOrEmpty(ev.ActionName))
                {
                    o["actionName"] = ev.ActionName;
                }
                if (ev.Gimmick)
                {
                    o["gimmick"] = true;
                }
                if (ev.IgnoreRouteLinkObjectId != 0)
                {
                    o["ignoreRouteLinkObjectId"] = ev.IgnoreRouteLinkObjectId;
                }
            }
#if !(FF1 || FF2 || FF3)
            // FF1-FF3 have no PropertyOpenTrigger; the trigger state is FF4-FF6 only.
            var open = p.TryCast<Last.Map.PropertyOpenTrigger>();
            if (open != null)
            {
                var trigger = entity.TryCast<Last.Entity.Field.FieldOpenTriggerEntity>();
                if (trigger != null)
                {
                    o["isAlreadyHit"] = trigger.IsAlreadyHit;
                    o["size"] = Vec(trigger.Size);
                }
            }
#endif
            found.Add(o);
        }
        return new JsonObject { ["total"] = list?.Count ?? 0, ["entities"] = found };
    }

    /// <summary>
    /// Every entity in every group the loaded map model carries, not just the group active
    /// now. 0.13.5: the model can ask for `kind: "All"` to see unknown map objects (a hole or
    /// a timed floor may live in an event group that <see cref="Entities"/> never walks).
    /// Known kinds still carry their fields; unknown kinds keep the class name and the
    /// property's generic fields.
    /// </summary>
    public static JsonObject AllEntities(int max)
    {
        if (!TryPlayer(out var controller, out _))
        {
            return null;
        }
        var found = new JsonArray();
        var model = CurrentMapModel(controller);
        var groups = model?.allEntityGroupList;
        if (groups != null)
        {
            foreach (var group in groups.Keys)
            {
                if (!groups.TryGetValue(group, out var list) || list == null)
                {
                    continue;
                }
                for (var i = 0; i < list.Count && found.Count < max; i++)
                {
                    var entity = list[i];
                    if (entity == null)
                    {
                        continue;
                    }
                    found.Add(EntityNode(controller, entity, group));
                }
            }
        }
        if (found.Count == 0)
        {
            var list = controller.entityList;
            for (var i = 0; list != null && i < list.Count && found.Count < max; i++)
            {
                var entity = list[i];
                if (entity != null)
                {
                    found.Add(EntityNode(controller, entity, null));
                }
            }
        }
        return new JsonObject
        {
            ["total"] = found.Count,
            ["entities"] = found,
        };
    }

    /// <summary>
    /// 0.13.6: what a chest entity holds and whether the save has opened it. The entity only
    /// carries FlagId/ContentId; the master's TreasureBox maps the flag to TreasureType (1 chest,
    /// 2 hidden item), and MapUIManager.GetTreasureFlag is the same test the achievements query
    /// uses. Content's MesIdName gives the item name. Read-only.
    /// </summary>
    private static void AddChestFields(JsonObject o, Last.Map.PropertyTresureBox chest)
    {
        o["content"] = chest.ContentId;
        o["num"] = chest.ContentNum;
        o["flag"] = chest.FlagId;
        try
        {
            var kinds = TreasureTypes();
            if (kinds.TryGetValue(chest.FlagId, out var type))
            {
                o["treasureType"] = type;
                o["hidden"] = type == 2;
            }
        }
        catch (Exception)
        {
            // The master list is unavailable while a map is loading; the flag is still useful.
        }
        try
        {
            o["opened"] = Last.Map.MapUIManager.GetTreasureFlag(chest.FlagId);
        }
        catch (Exception)
        {
            o["opened"] = null;
        }
        try
        {
            var names = ContentNames();
            if (names.TryGetValue(chest.ContentId, out var name))
            {
                o["contentName"] = name;
            }
        }
        catch (Exception)
        {
            // No name; the numeric content id remains.
        }
    }

    private static Dictionary<int, int> _treasureTypes;
    private static Dictionary<int, string> _contentNames;

    private static Dictionary<int, int> TreasureTypes()
    {
        if (_treasureTypes != null)
        {
            return _treasureTypes;
        }
        var types = new Dictionary<int, int>();
        var master = Il2CppSystem.SingletonMonoBehaviour<Last.Data.Master.MasterManager>.instance;
        var list = master?.GetList<Last.Data.Master.TreasureBox>();
        foreach (var pair in list)
        {
            var box = pair.Value;
            if (box != null)
            {
                types[box.Flag] = box.TreasureType;
            }
        }
        // Do not cache an empty read taken while the master was still loading.
        if (types.Count > 0)
        {
            _treasureTypes = types;
        }
        return types;
    }

    private static Dictionary<int, string> ContentNames()
    {
        if (_contentNames != null)
        {
            return _contentNames;
        }
        var names = new Dictionary<int, string>();
        var master = Il2CppSystem.SingletonMonoBehaviour<Last.Data.Master.MasterManager>.instance;
        var list = master?.GetList<Last.Data.Master.Content>();
        foreach (var pair in list)
        {
            var content = pair.Value;
            if (content != null)
            {
                var name = Clean(content.MesIdName);
                if (!string.IsNullOrEmpty(name))
                {
                    names[content.Id] = name;
                }
            }
        }
        if (names.Count > 0)
        {
            _contentNames = names;
        }
        return names;
    }

    private static Last.Map.MapModel CurrentMapModel(Last.Map.FieldController controller)
    {
        var models = controller.mapManager?.mapModelList;
        if (models == null)
        {
            return null;
        }
        var mapId = UserDataManager.instance?.CurrentMapId ?? -1;
        Last.Map.MapModel first = null;
        foreach (var key in models.Keys)
        {
            if (!models.TryGetValue(key, out var model) || model == null)
            {
                continue;
            }
            first ??= model;
            if (mapId < 0 || model.GetId() == mapId)
            {
                return model;
            }
        }
        return first;
    }

    private static JsonObject EntityNode(
        Last.Map.FieldController controller,
        Last.Entity.Field.FieldEntity entity,
        string group)
    {
        var p = entity.Property;
        var type = p != null ? p.GetIl2CppType().Name : entity.GetIl2CppType().Name;
        var o = new JsonObject
        {
            ["kind"] = type.StartsWith("Property", StringComparison.Ordinal) ? type[8..] : type,
            ["class"] = type,
        };
        if (group != null)
        {
            o["group"] = group;
        }
        if (p != null)
        {
            o["id"] = p.EntityId;
            o["objectId"] = p.ObjectId;
            o["objectType"] = p.ObjectType;
            o["direction"] = p.Direction;
            o["myLayer"] = p.MyLayer;
            o["name"] = p.Name;
            o["tile"] = Vec(p.TilePosition);
            o["size"] = Vec(p.Size);
            o["affected"] = p.Affected;
            o["visibleMinimap"] = p.VisibleMinimap;
            o["confirmLanding"] = p.ConfirmLanding;
            try
            {
                o["pos"] = Vec(p.Pos);
            }
            catch (Exception)
            {
                // Some property types do not fill Pos; TilePosition is enough.
            }
        }
        try
        {
            var cell = controller.ConvertWorldPositionToCellPosition(entity.transform.localPosition);
            o["cell"] = new JsonArray((int)Math.Round(cell.x), (int)Math.Round(cell.y));
        }
        catch (Exception)
        {
            o["cell"] = null;
        }
        try
        {
            o["active"] = entity.gameObject != null && entity.gameObject.activeInHierarchy;
        }
        catch (Exception)
        {
            o["active"] = null;
        }
        AddKnownFields(o, p, entity);
        return o;
    }

    private static void AddKnownFields(
        JsonObject o,
        Last.Map.PropertyEntity p,
        Last.Entity.Field.FieldEntity entity)
    {
        if (p == null)
        {
            return;
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
            AddChestFields(o, chest);
        }
        var npc = p.TryCast<Last.Map.PropertyNpc>();
        if (npc != null)
        {
            o["npc"] = npc.NpcId;
        }
        var toLayer = p.TryCast<Last.Map.PropertyToLayer>();
        if (toLayer != null)
        {
            o["layer"] = toLayer.Layer;
            o["changeLayer"] = toLayer.GetLayerType().ToString();
        }
        var pointIn = p.TryCast<Last.Map.PropertyPointIn>();
        if (pointIn != null)
        {
            o["linkObjectId"] = pointIn.LinkObjectId;
            o["titleId"] = pointIn.TitleId;
            o["titleType"] = pointIn.TitleType;
        }
        var tile = p.TryCast<Last.Map.PropertyTileAnimRegion>();
        if (tile != null)
        {
            o["isReverse"] = tile.IsReverse;
            var anim = entity.TryCast<Last.Entity.Field.FieldTileAnimRegionEntity>();
            if (anim != null)
            {
                o["isPlaying"] = anim.IsPlaying;
                var tiles = anim.animationUVDatas;
                var rows = new JsonArray();
                for (var i = 0; tiles != null && i < tiles.Length && i < 50; i++)
                {
                    var data = tiles[i];
                    if (data == null)
                    {
                        continue;
                    }
                    rows.Add(new JsonObject
                    {
                        ["tileId"] = data.tileId,
                        ["isTrigger"] = data.isTrigger,
                        ["isLoop"] = data.isLoop,
                    });
                }
                if (rows.Count > 0)
                {
                    o["animationTiles"] = rows;
                }
            }
        }
        var gimmick = p.TryCast<Last.Map.PropertyGimmick>();
        if (gimmick != null)
        {
            o["gimmickArea"] = RectNode(gimmick.GimmickArea);
            o["gimmickEnabled"] = gimmick.GimmickEnabled;
            o["allLayers"] = gimmick.AllLayers;
            o["linkObjectId"] = gimmick.LinkObjectId;
        }
        var sliding = p.TryCast<Last.Map.PropertySlidingFloorGimmickArea>();
        if (sliding != null)
        {
            o["slidingDirection"] = Vec(sliding.SlidingDirection);
            o["slidingAnimName"] = sliding.SlidingAnimName;
            o["slidingSpeed"] = sliding.SlidingSpeedID.ToString();
        }
        var timeSwitch = p.TryCast<Last.Map.PropertyTimeSwitchingGimmickArea>();
        if (timeSwitch != null)
        {
            o["switchSeconds"] = Round(timeSwitch.SwitchSeconds);
        }
        var damage = p.TryCast<Last.Map.PropertyDamageFloorGimmickArea>();
        if (damage != null)
        {
            var targets = damage.TargetCellList;
            var cells = new JsonArray();
            for (var i = 0; targets != null && i < targets.Count && i < 50; i++)
            {
                cells.Add(Vec(targets[i]));
            }
            o["targetCells"] = cells;
        }
        var collider = p.TryCast<Last.Map.PropertyColliderEntity>();
        if (collider != null)
        {
            o["collisionType"] = collider.CollisionType;
            o["throughConditionType"] = collider.ThroughConditionType;
        }
        var relay = p.TryCast<Last.Map.PropertyRelayInteraction>();
        if (relay != null)
        {
            o["horizontalCellLimit"] = relay.HorizontalCellLimit;
            o["verticalCellLimit"] = relay.VerticalCellLimit;
        }
        var ev = p.TryCast<Last.Map.PropertyEvent>();
        if (ev != null)
        {
            o["script"] = ev.ScriptId;
            o["linkObjectId"] = ev.LinkObjectId;
            o["actionId"] = ev.ActionId;
            if (!string.IsNullOrEmpty(ev.ActionName))
            {
                o["actionName"] = ev.ActionName;
            }
            if (ev.Gimmick)
            {
                o["gimmick"] = true;
            }
            if (ev.IgnoreRouteLinkObjectId != 0)
            {
                o["ignoreRouteLinkObjectId"] = ev.IgnoreRouteLinkObjectId;
            }
        }
#if !(FF1 || FF2 || FF3)
        var trigger = entity.TryCast<Last.Entity.Field.FieldOpenTriggerEntity>();
        if (trigger != null)
        {
            o["isAlreadyHit"] = trigger.IsAlreadyHit;
            o["triggerSize"] = Vec(trigger.Size);
        }
#endif
    }

    private static JsonObject RectNode(Rect r) =>
        new()
        {
            ["x"] = Round(r.x),
            ["y"] = Round(r.y),
            ["width"] = Round(r.width),
            ["height"] = Round(r.height),
        };

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
        var u = UserDataManager.instance;
        var o = new JsonObject
        {
            ["map"] = u?.CurrentMapId,
            ["area"] = u?.CurrentAreaId,
            ["areaType"] = u?.CurrentAreaType,
            ["areaText"] = u == null ? null : Text(u.CurrentArea),
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
#if FF5
        o["timer"] = Countdown();
#endif
        return o;
    }
}
