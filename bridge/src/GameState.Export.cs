#if FF5
using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using Il2CppInterop.Runtime;
using Last.Data.Master;
using Last.Defaine;
using Last.Defaine.Content;
using Last.Defaine.Master;
using Last.Management;
using Last.Systems;
using MasterManager = Last.Data.Master.MasterManager;

namespace FfprBridge;

/// <summary>
/// 0.14.5: one-shot export of the whole game's static data for the knowledge module
/// (task 92). Every table is read from the master data only: no map is loaded, no game
/// object is created and nothing is written. Rows are paginated by the caller because a
/// full bestiary does not fit in one websocket reply comfortably.
/// </summary>
internal static partial class GameState
{
    private const int ExportDefaultLimit = 200;
    private const int ExportMaxLimit = 500;

    /// <summary>
    /// The `export` query. `rows` is the requested page; `total` is the size of the whole
    /// table. An unknown table is an error, so a typo never looks like an empty table.
    /// </summary>
    public static JsonObject Export(string table, int offset, int limit)
    {
        if (string.IsNullOrEmpty(table))
        {
            throw new ArgumentException("export 需要 table");
        }
        var master = Il2CppSystem.SingletonMonoBehaviour<MasterManager>.instance;
        if (master == null)
        {
            throw new InvalidOperationException("主数据还没载入");
        }
        offset = Math.Max(0, offset);
        if (limit <= 0)
        {
            limit = ExportDefaultLimit;
        }
        limit = Math.Clamp(limit, 1, ExportMaxLimit);

        var rows = BuildExportRows(table);
        if (rows == null)
        {
            throw new ArgumentException($"未知的 export 表:{table}");
        }
        var total = rows.Count;
        var pageRows = new List<JsonObject>();
        for (var i = offset; i < rows.Count && i < offset + limit; i++)
        {
            pageRows.Add(rows[i]);
        }
        Dictionary<int, JsonObject> moves = null;
        if (table == "monsters" && pageRows.Count > 0)
        {
            // Reuse the task-90 reader once for the whole page: it scans loaded scripts on
            // every call, and scripts may not be loaded, in which case moves stays null.
            var ids = new List<int>();
            foreach (var row in pageRows)
            {
                var id = row["id"]?.GetValue<int>() ?? 0;
                if (id > 0)
                {
                    ids.Add(id);
                }
            }
            moves = new Dictionary<int, JsonObject>();
            try
            {
                var list = ids.Count == 0 ? null : MonsterMoves(ids.ToArray());
                for (var i = 0; list != null && i < list.Count; i++)
                {
                    var ai = list[i] as JsonObject;
                    var id = ai?["id"]?.GetValue<int>() ?? 0;
                    if (id > 0)
                    {
                        moves[id] = ai;
                    }
                }
            }
            catch (Exception)
            {
                moves = null;
            }
        }
        var page = new JsonArray();
        foreach (var row in pageRows)
        {
            if (table == "monsters")
            {
                JsonObject ai = null;
                var id = row["id"]?.GetValue<int>() ?? 0;
                if (moves != null && id > 0)
                {
                    moves.TryGetValue(id, out ai);
                }
                row["moves"] = MovesNode(ai);
            }
            page.Add(row);
        }
        return new JsonObject
        {
            ["table"] = table,
            ["total"] = total,
            ["offset"] = offset,
            ["rows"] = page,
            ["build"] = GameBuild(),
        };
    }

    private static List<JsonObject> BuildExportRows(string table)
    {
        switch (table)
        {
            case "maps":
                return MapsExport();
            case "monsters":
                return MonstersExport();
            case "encounters":
                return EncountersExport();
            case "treasures":
                return TreasuresExport();
            case "shops":
                return ShopsExport();
            case "items":
                return ItemsExport();
            case "magic":
                return MagicExport();
            default:
                return null;
        }
    }

    // ---------------------------------------------------------------- maps

    private static List<JsonObject> MapsExport()
    {
        var rows = new List<JsonObject>();
        var maps = Master()?.GetList<Map>();
        if (maps == null)
        {
            return rows;
        }
        foreach (var pair in maps)
        {
            var map = pair.Value;
            if (map == null)
            {
                continue;
            }
            Area area = null;
            try
            {
                area = Master().GetData<Area>(map.AreaId);
            }
            catch (Exception)
            {
                // A map without an Area row still exports its own fields.
            }
            var name = Localized(map.MapName);
            if (string.IsNullOrEmpty(name))
            {
                name = Localized(map.MapTitle);
            }
            rows.Add(new JsonObject
            {
                ["id"] = map.Id,
                ["name"] = name,
                ["areaId"] = map.AreaId,
                ["areaName"] = area == null ? null : Localized(area.AreaName),
                ["areaType"] = area == null ? null : area.MapType.ToString(),
            });
        }
        SortById(rows);
        return rows;
    }

    // ------------------------------------------------------------ monsters

    private static List<JsonObject> MonstersExport()
    {
        var rows = new List<JsonObject>();
        var master = Master();
        var monsters = master?.GetList<Monster>();
        if (monsters == null)
        {
            return rows;
        }
        var attributeGroups = GroupAttributes(master);
        var conditionGroups = GroupConditions(master);
        foreach (var pair in monsters)
        {
            var monster = pair.Value;
            if (monster == null)
            {
                continue;
            }
            var row = new JsonObject
            {
                ["id"] = monster.Id,
                ["name"] = Localized(monster.MesIdName),
                ["bookId"] = BookNumber(monster.Id),
                ["level"] = ReadInt(() => monster.Lv),
                ["hp"] = ReadInt(() => monster.Hp),
                ["mp"] = ReadInt(() => monster.Mp),
                ["weak"] = AttributeNames(monster.ResistanceAttribute, attributeGroups, ResistanceAttributeType.Weak),
                ["absorb"] = AttributeNames(monster.ResistanceAttribute, attributeGroups, ResistanceAttributeType.Absorption),
                ["nullify"] = AttributeNames(monster.ResistanceAttribute, attributeGroups, ResistanceAttributeType.Invalid),
                ["statusImmune"] = ConditionNames(monster.ResistanceCondition, conditionGroups),
                ["drops"] = Drops(monster),
                ["steal"] = Steals(monster),
                ["boss"] = ReadBool(() => monster.Boss != 0),
                // The knowledge module keeps this as text; the master field is an int.
                ["scriptId"] = ReadString(() => monster.ScriptId.ToString()),
            };
            rows.Add(row);
        }
        SortById(rows);
        return rows;
    }

    private static Dictionary<int, List<AttributeGroup>> GroupAttributes(MasterManager master)
    {
        var groups = new Dictionary<int, List<AttributeGroup>>();
        var list = master.GetList<AttributeGroup>();
        if (list == null)
        {
            return groups;
        }
        foreach (var pair in list)
        {
            var row = pair.Value;
            if (row == null)
            {
                continue;
            }
            if (!groups.TryGetValue(row.GroupId, out var group))
            {
                group = new List<AttributeGroup>();
                groups[row.GroupId] = group;
            }
            group.Add(row);
        }
        return groups;
    }

    private static Dictionary<int, List<int>> GroupConditions(MasterManager master)
    {
        var groups = new Dictionary<int, List<int>>();
        var list = master.GetList<ConditionGroup>();
        if (list == null)
        {
            return groups;
        }
        foreach (var pair in list)
        {
            var row = pair.Value;
            if (row == null)
            {
                continue;
            }
            if (!groups.TryGetValue(row.GroupId, out var group))
            {
                group = new List<int>();
                groups[row.GroupId] = group;
            }
            group.Add(row.ConditionId);
        }
        return groups;
    }

    private static JsonArray AttributeNames(
        int groupId,
        Dictionary<int, List<AttributeGroup>> groups,
        ResistanceAttributeType wanted)
    {
        var names = new JsonArray();
        if (!groups.TryGetValue(groupId, out var rows))
        {
            return names;
        }
        var seen = new HashSet<string>();
        foreach (var row in rows)
        {
            if (!MatchesAttribute(row.TypeId, wanted))
            {
                continue;
            }
            var name = Localized(row.MesIdName);
            if (string.IsNullOrEmpty(name))
            {
                name = Enum.GetName(typeof(AttributeType), row.AttributeId) ?? $"#{row.AttributeId}";
            }
            if (!string.IsNullOrEmpty(name) && seen.Add(name))
            {
                names.Add(name);
            }
        }
        return names;
    }

    /// <summary>Weak/invalid/absorption, including the combined rows (401/403).</summary>
    private static bool MatchesAttribute(int typeId, ResistanceAttributeType wanted)
    {
        switch (wanted)
        {
            case ResistanceAttributeType.Weak:
                return typeId == (int)ResistanceAttributeType.Weak ||
                    typeId == (int)ResistanceAttributeType.DoubleWeak;
            case ResistanceAttributeType.Invalid:
                return typeId == (int)ResistanceAttributeType.Invalid;
            case ResistanceAttributeType.Absorption:
                return typeId == (int)ResistanceAttributeType.Absorption ||
                    typeId == (int)ResistanceAttributeType.AbsorptionWeakPhysics;
            default:
                return false;
        }
    }

    private static JsonArray ConditionNames(
        int groupId,
        Dictionary<int, List<int>> groups)
    {
        var names = new JsonArray();
        if (!groups.TryGetValue(groupId, out var ids))
        {
            return names;
        }
        var seen = new HashSet<string>();
        foreach (var id in ids)
        {
            Condition condition = null;
            try
            {
                condition = Master().GetData<Condition>(id);
            }
            catch (Exception)
            {
            }
            var name = ConditionName(condition);
            if (!string.IsNullOrEmpty(name) && seen.Add(name))
            {
                names.Add(name);
            }
        }
        return names;
    }

    /// <summary>
    /// Drop slots carry a ContentId and a Value (amount), while Monster.DropRate is the
    /// chance. Slot/rate semantics are inferred from DropItemData.DropValue and need a
    /// real-machine check.
    /// </summary>
    private static JsonArray Drops(Monster monster)
    {
        var rows = new JsonArray();
        var seen = new HashSet<int>();
        var rate = ReadInt(() => monster.DropRate);
        for (var slot = 1; slot <= 8; slot++)
        {
            var contentId = IntProperty(monster, $"DropContentId{slot}");
            if (contentId is null or 0 || !seen.Add(contentId.Value))
            {
                continue;
            }
            rows.Add(new JsonObject
            {
                ["itemId"] = contentId,
                ["name"] = ContentName(contentId.Value),
                ["rate"] = rate,
            });
        }
        return rows;
    }

    private static JsonArray Steals(Monster monster)
    {
        var rows = new JsonArray();
        var seen = new HashSet<int>();
        for (var slot = 1; slot <= 4; slot++)
        {
            var contentId = IntProperty(monster, $"StealContentId{slot}");
            if (contentId is null or 0 || !seen.Add(contentId.Value))
            {
                continue;
            }
            rows.Add(new JsonObject
            {
                ["itemId"] = contentId,
                ["name"] = ContentName(contentId.Value),
                // The Steal master has no per-slot rate; the rare/common split is not decoded.
                ["rate"] = null,
            });
        }
        return rows;
    }

    private static JsonNode MovesNode(JsonObject ai)
    {
        if (ai == null || ai["moves"] is not JsonArray moves)
        {
            return null;
        }
        var result = new JsonArray();
        foreach (var node in moves)
        {
            if (node is not JsonObject move)
            {
                continue;
            }
            var conditions = new JsonArray();
            if (move["conditions"] is JsonArray list)
            {
                foreach (var condition in list)
                {
                    var text = condition?.GetValue<string>();
                    if (!string.IsNullOrEmpty(text))
                    {
                        conditions.Add(text);
                    }
                }
            }
            var rate = ReadDouble(() => move["rate"]?.GetValue<double>());
            result.Add(new JsonObject
            {
                ["abilityId"] = ReadInt(() => move["abilityId"]?.GetValue<int>()),
                ["name"] = ReadString(() => move["name"]?.GetValue<string>()),
                ["blueMagic"] = ReadBool(() => move["blueMagic"]?.GetValue<bool>()),
                ["conditions"] = conditions,
                ["rate"] = rate.HasValue ? Math.Round(rate.Value, 3) : null,
            });
        }
        return result;
    }

    // ----------------------------------------------------------- encounters

    /// <summary>
    /// Every encounter table in the master: each map's MonsterSet and every world-map
    /// EncountArea. One row is one MonsterParty with its MonsterSet rate and monsters.
    /// groupId is the MonsterParty id (the same id the `encounters` query calls `id`);
    /// area rows use EncountArea.Id because that table has no map id.
    /// </summary>
    private static List<JsonObject> EncountersExport()
    {
        var rows = new List<JsonObject>();
        var master = Master();
        var maps = master?.GetList<Map>();
        if (maps != null)
        {
            foreach (var pair in maps)
            {
                var map = pair.Value;
                if (map == null || map.MonsterSetId <= 0)
                {
                    continue;
                }
                var set = MasterData<MonsterSet>(map.MonsterSetId);
                AppendMonsterSet(rows, set, "map", map.Id, map.AreaId);
            }
        }
        var areas = master?.GetList<EncountArea>();
        if (areas != null)
        {
            foreach (var pair in areas)
            {
                var area = pair.Value;
                if (area == null)
                {
                    continue;
                }
                for (var slot = 1; slot <= 32; slot++)
                {
                    var setId = IntProperty(area, $"Foot{slot:00}MonsterSet");
                    if (setId is null or 0)
                    {
                        continue;
                    }
                    var set = MasterData<MonsterSet>(setId.Value);
                    AppendMonsterSet(rows, set, "area", null, area.Id);
                }
            }
        }
        rows.Sort((a, b) =>
        {
            var scope = string.CompareOrdinal(a["scope"]?.GetValue<string>(), b["scope"]?.GetValue<string>());
            if (scope != 0)
            {
                return scope;
            }
            var mapId = (a["mapId"]?.GetValue<int>() ?? 0).CompareTo(b["mapId"]?.GetValue<int>() ?? 0);
            if (mapId != 0)
            {
                return mapId;
            }
            var areaId = (a["areaId"]?.GetValue<int>() ?? 0).CompareTo(b["areaId"]?.GetValue<int>() ?? 0);
            return areaId != 0
                ? areaId
                : (a["groupId"]?.GetValue<int>() ?? 0).CompareTo(b["groupId"]?.GetValue<int>() ?? 0);
        });
        return rows;
    }

    private static void AppendMonsterSet(
        List<JsonObject> rows,
        MonsterSet set,
        string scope,
        int? mapId,
        int? areaId)
    {
        if (set == null)
        {
            return;
        }
        for (var slot = 1; slot <= 16; slot++)
        {
            var partyId = IntProperty(set, $"MonsterSet{slot}");
            if (partyId is null or 0)
            {
                continue;
            }
            var rate = IntProperty(set, $"MonsterSet{slot}Rate");
            rows.Add(new JsonObject
            {
                ["scope"] = scope,
                ["mapId"] = mapId,
                ["areaId"] = areaId,
                ["groupId"] = partyId,
                ["weight"] = rate,
                ["monsterIds"] = PartyMonsterIds(partyId.Value),
            });
        }
    }

    private static JsonArray PartyMonsterIds(int partyId)
    {
        var ids = new JsonArray();
        var party = MasterData<MonsterParty>(partyId);
        if (party == null)
        {
            return ids;
        }
        for (var slot = 1; slot <= 9; slot++)
        {
            var id = IntProperty(party, $"Monster{slot}");
            if (id is > 0)
            {
                ids.Add(id.Value);
            }
        }
        return ids;
    }

    // ------------------------------------------------------------ treasures

    /// <summary>
    /// TreasureBox has only Id/Flag/GpsAreaId/TreasureType/Count: no map id, cell or
    /// content id. Those live on the map's PropertyTresureBox entities, which would need a
    /// loaded map, so they are null here. TreasureType 2 is the hidden-item kind (0.13.6).
    /// </summary>
    private static List<JsonObject> TreasuresExport()
    {
        var rows = new List<JsonObject>();
        var boxes = Master()?.GetList<TreasureBox>();
        if (boxes == null)
        {
            return rows;
        }
        foreach (var pair in boxes)
        {
            var box = pair.Value;
            if (box == null)
            {
                continue;
            }
            rows.Add(new JsonObject
            {
                ["id"] = box.Id,
                ["areaId"] = box.GpsAreaId,
                ["mapId"] = null,
                ["cell"] = null,
                ["hidden"] = box.TreasureType == 2,
                ["contentId"] = null,
                ["contentName"] = null,
                ["count"] = ReadInt(() => box.Count),
                // The knowledge module matches opened chests by id or by this text flag.
                ["flag"] = ReadString(() => box.Flag.ToString()),
            });
        }
        SortById(rows);
        return rows;
    }

    // ---------------------------------------------------------------- shops

    /// <summary>
    /// A shop is a ProductGroup; Product rows with the same GroupId are its stock. The
    /// matching ShopSign (same Id, inferred) gives the GPS area and kind, and ShopSign's
    /// GpsAreaId is the Area id used by TreasureBox and the `pos.area` field. Prices are
    /// the Content master's Buy value, scaled by Product.Coefficient (inferred).
    /// </summary>
    private static List<JsonObject> ShopsExport()
    {
        var rows = new List<JsonObject>();
        var master = Master();
        var groups = new Dictionary<int, string>();
        var groupList = master.GetList<ProductGroup>();
        if (groupList != null)
        {
            foreach (var pair in groupList)
            {
                if (pair.Value != null)
                {
                    groups[pair.Key] = Localized(pair.Value.MesIdName);
                }
            }
        }
        var products = new Dictionary<int, List<Product>>();
        var productList = master.GetList<Product>();
        if (productList != null)
        {
            foreach (var pair in productList)
            {
                var product = pair.Value;
                if (product == null)
                {
                    continue;
                }
                if (!products.TryGetValue(product.GroupId, out var list))
                {
                    list = new List<Product>();
                    products[product.GroupId] = list;
                }
                list.Add(product);
            }
        }
        var signs = new Dictionary<int, ShopSign>();
        var signList = master.GetList<ShopSign>();
        if (signList != null)
        {
            foreach (var pair in signList)
            {
                if (pair.Value != null && !signs.ContainsKey(pair.Key))
                {
                    signs[pair.Key] = pair.Value;
                }
            }
        }
        var mapByArea = MapIdsByArea(master);
        var ids = new SortedSet<int>(groups.Keys);
        foreach (var id in products.Keys)
        {
            ids.Add(id);
        }
        foreach (var id in ids)
        {
            signs.TryGetValue(id, out var sign);
            int? areaId = sign == null ? null : sign.GpsAreaId;
            var areaName = areaId.HasValue ? AreaName(areaId.Value) : null;
            int? mapId = null;
            if (areaId.HasValue && mapByArea.TryGetValue(areaId.Value, out var found))
            {
                mapId = found;
            }
            var productRows = new JsonArray();
            if (products.TryGetValue(id, out var list))
            {
                list.Sort((a, b) => a.Id.CompareTo(b.Id));
                foreach (var product in list)
                {
                    var content = MasterData<Content>(product.ContentId);
                    productRows.Add(new JsonObject
                    {
                        ["itemId"] = product.ContentId,
                        ["name"] = content == null ? null : Localized(content.MesIdName),
                        ["price"] = ProductPrice(content, product.Coefficient),
                    });
                }
            }
            rows.Add(new JsonObject
            {
                ["id"] = id,
                ["mapId"] = mapId,
                ["areaName"] = areaName,
                ["kind"] = sign == null
                    ? null
                    : Enum.GetName(
                        typeof(Serial.FF5.UI.Common.Map.ShopSign.ShopSignType),
                        sign.SignType),
                ["products"] = productRows,
            });
        }
        return rows;
    }

    private static Dictionary<int, int> MapIdsByArea(MasterManager master)
    {
        var result = new Dictionary<int, int>();
        var maps = master.GetList<Map>();
        if (maps != null)
        {
            foreach (var pair in maps)
            {
                var map = pair.Value;
                if (map != null && map.AreaId > 0 && !result.ContainsKey(map.AreaId))
                {
                    result[map.AreaId] = map.Id;
                }
            }
        }
        return result;
    }

    private static int? ProductPrice(Content content, int coefficient)
    {
        if (content == null)
        {
            return null;
        }
        var id = content.TypeValue > 0 ? content.TypeValue : content.Id;
        int? buy = null;
        switch ((ContentType)content.TypeId)
        {
            case ContentType.Item:
                buy = ReadInt(() => MasterData<Item>(id)?.Buy);
                break;
            case ContentType.Weapon:
                buy = ReadInt(() => MasterData<Weapon>(id)?.Buy);
                break;
            case ContentType.Armor:
                buy = ReadInt(() => MasterData<Armor>(id)?.Buy);
                break;
            case ContentType.Ability:
                buy = ReadInt(() => MasterData<Ability>(id)?.Buy);
                break;
            case ContentType.MagicItem:
            case ContentType.MagicStone:
                buy = ReadInt(() => MasterData<Magic>(id)?.Buy);
                break;
        }
        if (!buy.HasValue || buy.Value <= 0)
        {
            return buy;
        }
        // Coefficient is inferred: 100 (or 0) means the master Buy price, otherwise a scale.
        if (coefficient > 0 && coefficient != 100)
        {
            return (int)Math.Round(buy.Value * coefficient / 100d);
        }
        return buy;
    }

    // ---------------------------------------------------------------- items

    private static List<JsonObject> ItemsExport()
    {
        var rows = new List<JsonObject>();
        var contents = Master()?.GetList<Content>();
        if (contents == null)
        {
            return rows;
        }
        foreach (var pair in contents)
        {
            var content = pair.Value;
            if (content == null || !IsItemKind((ContentType)content.TypeId))
            {
                continue;
            }
            var id = content.TypeValue > 0 ? content.TypeValue : content.Id;
            var kind = (ContentType)content.TypeId;
            var item = kind == ContentType.Item ? MasterData<Item>(id) : null;
            var cures = new JsonArray();
            var restores = (JsonNode)null;
            var price = ReadInt(() =>
                kind == ContentType.Item ? MasterData<Item>(id)?.Buy
                : kind == ContentType.Weapon ? MasterData<Weapon>(id)?.Buy
                : MasterData<Armor>(id)?.Buy);
            if (item != null)
            {
                cures = Cures(item.MenuFunctionGroupId, item.BattleFunctionGroupId);
                restores = Restores(item.StandardValue, item.MenuFunctionGroupId, item.BattleFunctionGroupId);
            }
            rows.Add(new JsonObject
            {
                ["id"] = content.Id,
                ["name"] = Localized(content.MesIdName),
                ["kind"] = kind.ToString(),
                ["price"] = price,
                ["cures"] = cures,
                ["restores"] = restores,
            });
        }
        SortById(rows);
        return rows;
    }

    private static bool IsItemKind(ContentType type)
    {
        return type == ContentType.Item || type == ContentType.Weapon || type == ContentType.Armor;
    }

    /// <summary>
    /// RecoveryCondition values are condition ids or condition-group ids; both are accepted
    /// because the value layout is inferred. Names fall back to ConditionType.
    /// </summary>
    private static JsonArray Cures(params int[] functionGroups)
    {
        var names = new JsonArray();
        var seen = new HashSet<string>();
        foreach (var groupId in functionGroups)
        {
            var group = groupId <= 0 ? null : MasterData<FunctionGroup>(groupId);
            if (group == null)
            {
                continue;
            }
            for (var slot = 1; slot <= 3; slot++)
            {
                var functionId = IntProperty(group, $"Function{slot}Id");
                var function = functionId is null or 0 ? null : MasterData<Function>(functionId.Value);
                if (function == null)
                {
                    continue;
                }
                var type = (FunctionType)function.TypeId;
                if (type != FunctionType.RecoveryCondition &&
                    type != FunctionType.RecoveryConditionMulti &&
                    type != FunctionType.UserRecoveryCondition)
                {
                    continue;
                }
                for (var value = 1; value <= 3; value++)
                {
                    var id = IntProperty(group, $"Function{slot}Value{value}");
                    if (id is not > 0)
                    {
                        continue;
                    }
                    AddCondition(id.Value, names, seen);
                }
            }
        }
        return names;
    }

    private static void AddCondition(int id, JsonArray names, HashSet<string> seen)
    {
        Condition condition = null;
        try
        {
            condition = Master().GetData<Condition>(id);
        }
        catch (Exception)
        {
        }
        if (condition != null)
        {
            var name = ConditionName(condition);
            if (!string.IsNullOrEmpty(name) && seen.Add(name))
            {
                names.Add(name);
            }
            return;
        }
        // Not a Condition id: try it as a ConditionGroup id.
        try
        {
            var list = GroupMasterUtility.GetConditionMasters(id);
            for (var i = 0; list != null && i < list.Count; i++)
            {
                var name = ConditionName(list[i]);
                if (!string.IsNullOrEmpty(name) && seen.Add(name))
                {
                    names.Add(name);
                }
            }
        }
        catch (Exception)
        {
        }
    }

    /// <summary>
    /// Item.StandardValue is the amount for the Recovery function. Recovery is read as HP and
    /// RecoveryEx as MP; which one the game uses for a given item is inferred (e.g. Ether).
    /// </summary>
    private static JsonObject Restores(int standardValue, params int[] functionGroups)
    {
        int? hp = null;
        int? mp = null;
        foreach (var groupId in functionGroups)
        {
            var group = groupId <= 0 ? null : MasterData<FunctionGroup>(groupId);
            if (group == null)
            {
                continue;
            }
            for (var slot = 1; slot <= 3; slot++)
            {
                var functionId = IntProperty(group, $"Function{slot}Id");
                var function = functionId is null or 0 ? null : MasterData<Function>(functionId.Value);
                if (function == null)
                {
                    continue;
                }
                switch ((FunctionType)function.TypeId)
                {
                    case FunctionType.Recovery:
                    case FunctionType.BaseValueFixedHPRecovery:
                    case FunctionType.ResultValueFixedHPRecovery:
                        if (standardValue > 0)
                        {
                            hp = Math.Max(hp ?? 0, standardValue);
                        }
                        break;
                    case FunctionType.RecoveryEx:
                        if (standardValue > 0)
                        {
                            mp = Math.Max(mp ?? 0, standardValue);
                        }
                        break;
                }
            }
        }
        if (hp == null && mp == null)
        {
            return null;
        }
        var o = new JsonObject();
        if (hp.HasValue)
        {
            o["hp"] = hp.Value;
        }
        if (mp.HasValue)
        {
            o["mp"] = mp.Value;
        }
        return o;
    }

    // ---------------------------------------------------------------- magic

    /// <summary>
    /// Magic schools come from Ability.TypeId, the same table task 90 uses for blue magic.
    /// Enumerating Ability (instead of the smaller Magic master) includes summon and blue
    /// spells. Names use the game's own Ability resolver; school is the AbilityType name.
    /// </summary>
    private static List<JsonObject> MagicExport()
    {
        var rows = new List<JsonObject>();
        var abilities = Master()?.GetList<Ability>();
        if (abilities == null)
        {
            return rows;
        }
        foreach (var pair in abilities)
        {
            var ability = pair.Value;
            if (ability == null || !IsMagicSchool((AbilityType)ability.TypeId))
            {
                continue;
            }
            var info = AbilityInfo(ability.Id);
            rows.Add(new JsonObject
            {
                ["id"] = ability.Id,
                ["name"] = info.Name,
                ["school"] = Enum.GetName(typeof(AbilityType), ability.TypeId),
                ["mp"] = ReadInt(() => ability.UseValue),
                ["cures"] = Cures(ability.MenuFunctionGroupId, ability.BattleFunctionGroupId),
            });
        }
        SortById(rows);
        return rows;
    }

    private static bool IsMagicSchool(AbilityType type)
    {
        return type == AbilityType.White ||
            type == AbilityType.Black ||
            type == AbilityType.TimeMagic ||
            type == AbilityType.Summon ||
            type == AbilityType.BlueMagic;
    }

    // --------------------------------------------------------------- common

    private static MasterManager Master()
    {
        return Il2CppSystem.SingletonMonoBehaviour<MasterManager>.instance;
    }

    private static T MasterData<T>(int id) where T : MasterBase
    {
        if (id <= 0)
        {
            return null;
        }
        try
        {
            return Master()?.GetData<T>(id);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static string ContentName(int contentId)
    {
        var content = MasterData<Content>(contentId);
        return content == null ? null : Localized(content.MesIdName);
    }

    /// <summary>The game's text, then the raw value when it is a literal rather than a key.</summary>
    private static string Localized(string key)
    {
        if (string.IsNullOrEmpty(key))
        {
            return null;
        }
        var text = Clean(key);
        if (!string.IsNullOrEmpty(text))
        {
            return text;
        }
        if (key.IndexOf("MSG_", StringComparison.Ordinal) < 0 &&
            !string.Equals(key, "None", StringComparison.OrdinalIgnoreCase))
        {
            return key;
        }
        return null;
    }

    private static string GameBuild()
    {
        try
        {
            var version = UnityEngine.Application.version;
            return string.IsNullOrEmpty(version) ? null : version;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static void SortById(List<JsonObject> rows)
    {
        rows.Sort((a, b) =>
            (a["id"]?.GetValue<int>() ?? 0).CompareTo(b["id"]?.GetValue<int>() ?? 0));
    }

    private static int? ReadInt(Func<int?> read)
    {
        try
        {
            return read();
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static bool? ReadBool(Func<bool?> read)
    {
        try
        {
            return read();
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static string ReadString(Func<string> read)
    {
        try
        {
            return read();
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static double? ReadDouble(Func<double?> read)
    {
        try
        {
            return read();
        }
        catch (Exception)
        {
            return null;
        }
    }
}
#endif
