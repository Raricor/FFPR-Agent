using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using Last.Management;
using AchievementMaster = Last.Data.Master.Achievement;

namespace FfprBridge;

/// <summary>
/// Achievement progress for the current save. The master and the account list are what the
/// game's own achievement screen shows; the save block is read from UserDataManager and the
/// game's static counters because Steam (and AchievementManager.values) never go backwards and
/// are shared by every save. Read only: no Update*, SetProgress or Upload* call.
/// </summary>
internal static partial class GameState
{
    /// <summary>Types whose progress is a cumulative count rather than a scenario flag.</summary>
    private static readonly HashSet<string> CountTypes = new()
    {
        "OwnedGil",
        "SlotTotalGil",
        "MonsterSubjugationCount",
        "PictureBookComplete",
        "ChestComplete",
        "HiddenItems",
        "MemberLevel",
        "JobMasters",
        "LearningBlueMagic",
        "AllComplete",
    };

    public static JsonObject Achievements()
    {
        var o = new JsonObject();
        JsonArray defs = null;
        try
        {
            defs = Definitions();
        }
        catch (Exception)
        {
            // The master data is not loaded yet; the caller sees defs:null.
        }
        o["defs"] = defs;
        try
        {
            o["account"] = Account();
        }
        catch (Exception)
        {
            o["account"] = null;
        }
        try
        {
            o["save"] = Save(defs);
        }
        catch (Exception)
        {
            o["save"] = null;
        }
        if (o["save"] == null)
        {
            // 10-28: at the title, the boxes per place still come from the master data, so a game
            // with no save yet can be mapped (open counts are then meaningless: only `total`).
            o["treasure"] = Read(() => Treasure());
        }
        try
        {
            o["bestiary"] = BestiaryProgress();
        }
        catch (Exception)
        {
            o["bestiary"] = null;
        }
        return o;
    }

    /// <summary>Every achievement master row, ordered by id.</summary>
    private static JsonArray Definitions()
    {
        var master = Il2CppSystem.SingletonMonoBehaviour<Last.Data.Master.MasterManager>.instance;
        var list = master?.GetList<AchievementMaster>();
        if (list == null)
        {
            return null;
        }
        var rows = new List<KeyValuePair<int, AchievementMaster>>();
        foreach (var pair in list)
        {
            if (pair.Value != null)
            {
                rows.Add(new KeyValuePair<int, AchievementMaster>(pair.Key, pair.Value));
            }
        }
        rows.Sort((a, b) => a.Key.CompareTo(b.Key));
        var defs = new JsonArray();
        foreach (var pair in rows)
        {
            var a = pair.Value;
            try
            {
                defs.Add(new JsonObject
                {
                    ["id"] = a.Id,
                    ["api"] = a.AchievmentId,
                    ["type"] = a.Type,
                    ["typeName"] = Enum.GetName(typeof(Last.Management.AchievementManager.Type), a.Type),
                    ["value"] = a.Value,
                    ["condition"] = a.ConditionValue,
                    ["platform"] = a.PlatformType,
                });
            }
            catch (Exception)
            {
                defs.Add(null);
            }
        }
        return defs;
    }

    /// <summary>The account-wide list, or null before it exists (the title screen).</summary>
    private static JsonArray Account()
    {
        var manager = Il2CppSystem.SingletonMonoBehaviour<Last.Management.AchievementManager>.instance;
        var values = manager?.values;
        if (values == null || values.Count == 0)
        {
            return null;
        }
        var rows = new JsonArray();
        for (var i = 0; i < values.Count; i++)
        {
            var v = values[i];
            if (v == null)
            {
                rows.Add(null);
                continue;
            }
            try
            {
                rows.Add(new JsonObject
                {
                    ["api"] = v.AchievmentId,
                    ["achieved"] = v.Achieved,
                    ["current"] = v.ProgressCurrentValue,
                    ["max"] = v.ProgressMaxValue,
                    ["name"] = v.achievmentName,
                    ["description"] = v.achievmentDescription,
                });
            }
            catch (Exception)
            {
                rows.Add(null);
            }
        }
        return rows;
    }

    /// <summary>
    /// The account-wide bestiary: one row per number, whether any of its master entries has a
    /// positive defeat count, and the union of their habitat areas. Checked live on 10-27 with
    /// 0.7.8: 45 of the 302 numbers counted as registered, equal to the account's picture_book
    /// current, and every number had at least one area.
    /// </summary>
    private static JsonNode BestiaryProgress()
    {
        var master = Il2CppSystem.SingletonMonoBehaviour<Last.Data.Master.MasterManager>.instance;
        var books = master?.GetList<Last.Data.Master.PictureBook>();
        var groups = Groups();
        if (master == null || books == null || groups.Count == 0)
        {
            return null;
        }
        var habitatGroups = new Dictionary<int, Last.Data.Master.HabitatPointGroup>();
        var groupList = master.GetList<Last.Data.Master.HabitatPointGroup>();
        foreach (var pair in groupList)
        {
            if (pair.Value != null)
            {
                habitatGroups[pair.Key] = pair.Value;
            }
        }
        // HabitatPointGroup.GroupId is the key shared with HabitatPoint.GroupId; the group row
        // itself is selected by PictureBook.HabitatPointGroupId -> HabitatPointGroup.Id.
        var pointsByGroup = new Dictionary<int, List<Last.Data.Master.HabitatPoint>>();
        var pointList = master.GetList<Last.Data.Master.HabitatPoint>();
        foreach (var pair in pointList)
        {
            var point = pair.Value;
            if (point == null)
            {
                continue;
            }
            if (!pointsByGroup.TryGetValue(point.GroupId, out var points))
            {
                points = new List<Last.Data.Master.HabitatPoint>();
                pointsByGroup[point.GroupId] = points;
            }
            points.Add(point);
        }
        var defeats = Last.Management.PictureBookSaveManager.Instance()?.SaveData?.MonsterDefeats;
        if (defeats == null)
        {
            return null;
        }
        var sorted = new List<Il2CppSystem.Collections.Generic.KeyValuePair<int, Last.Data.Master.PictureBook>>();
        foreach (var pair in books)
        {
            if (pair.Value != null)
            {
                sorted.Add(pair);
            }
        }
        sorted.Sort((a, b) => a.Key.CompareTo(b.Key));
        var entries = new Dictionary<int, BestiaryRow>();
        foreach (var pair in sorted)
        {
            var book = pair.Value;
            if (!groups.TryGetValue(book.Id, out var group))
            {
                continue;
            }
            if (!entries.TryGetValue(group.Group, out var entry))
            {
                entry = new BestiaryRow
                {
                    Number = group.Group,
                    Name = MonsterName(master, book.MonsterId),
                };
                entries[group.Group] = entry;
            }
            if (!entry.Registered && defeats.TryGetValue(book.MonsterId, out var count) && count > 0)
            {
                entry.Registered = true;
            }
            if (habitatGroups.TryGetValue(book.HabitatPointGroupId, out var habitat) && habitat != null &&
                pointsByGroup.TryGetValue(habitat.GroupId, out var points))
            {
                foreach (var point in points)
                {
                    entry.Areas.Add(point.AreaId);
                }
            }
        }
        var numbers = new List<int>(entries.Keys);
        numbers.Sort();
        var rows = new JsonArray();
        var areaIds = new SortedSet<int>();
        foreach (var number in numbers)
        {
            var entry = entries[number];
            var areas = new JsonArray();
            foreach (var area in entry.Areas)
            {
                areas.Add(area);
                areaIds.Add(area);
            }
            rows.Add(new JsonObject
            {
                ["number"] = entry.Number,
                ["name"] = entry.Name,
                ["registered"] = entry.Registered,
                ["areas"] = areas,
            });
        }
        var names = new JsonObject();
        foreach (var area in areaIds)
        {
            names[area.ToString()] = AreaName(area);
        }
        return new JsonObject { ["entries"] = rows, ["areas"] = names };
    }

    /// <summary>The first master entry's monster name for this bestiary number.</summary>
    private static string MonsterName(Last.Data.Master.MasterManager master, int monsterId)
    {
        try
        {
            var monster = master.GetData<Last.Data.Master.Monster>(monsterId);
            return monster == null ? null : Text(monster.MesIdName);
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>The current save's counters and party, or null when no save is loaded.</summary>
    private static JsonObject Save(JsonArray defs)
    {
        var u = UserDataManager.instance;
        var owned = u?.OwnedCharacterList;
        if (owned == null || owned.Count == 0)
        {
            return null;
        }
        var o = new JsonObject
        {
            ["playTime"] = Read(() => (int)Math.Round(u.PlayTime)),
            ["saveCount"] = Read(() => u.SaveCompleteCount),
            ["gil"] = Read(() => u.OwendGil),
#if !(FF1 || FF2 || FF3)
            ["totalGil"] = Read(() => u.TotalGil),
#endif
            ["kills"] = Read(() => u.MonstersKilledCount),
            ["battles"] = Read(() => u.BattleCount),
            ["chests"] = Read(() => Last.Map.TresureBoxUtility.GetOpenChestCount()),
            ["openChestCount"] = Read(() => u.OpenChestCount),
            // Each game's own default: FF5 isIncludeZeroCount = false, FF6 isFlagDuplicate = true,
            // FF1-FF4 take no argument.
            ["hiddenItems"] = Read(() => Last.Map.TresureBoxUtility.GetOpenHiddenItemCount()),
            ["treasure"] = Read(() => Treasure()),
            ["members"] = Read(() => Members(owned)),
            ["releasedJobs"] = Read(() => ReleasedJobs(u)),
            ["flags"] = Read(() => Flags(defs)),
        };
        return o;
    }

    /// <summary>
    /// Treasure boxes and hidden items grouped by (GpsAreaId, TreasureType), with the game's own
    /// flag test for each one. Open is null when a flag read throws, so total still says how many
    /// that place has.
    /// </summary>
    private static JsonNode Treasure()
    {
        var master = Il2CppSystem.SingletonMonoBehaviour<Last.Data.Master.MasterManager>.instance;
        var list = master?.GetList<Last.Data.Master.TreasureBox>();
        if (list == null)
        {
            return null;
        }
        var groups = new Dictionary<(int Area, int Type), TreasureGroup>();
        foreach (var pair in list)
        {
            var box = pair.Value;
            if (box == null)
            {
                continue;
            }
            var key = (box.GpsAreaId, box.TreasureType);
            if (!groups.TryGetValue(key, out var group))
            {
                group = new TreasureGroup { Area = key.GpsAreaId, Type = key.TreasureType };
                groups.Add(key, group);
            }
            group.Total++;
            if (group.Open == null)
            {
                continue;
            }
            try
            {
                if (Last.Map.MapUIManager.GetTreasureFlag(box.Flag))
                {
                    group.Open = group.Open.Value + 1;
                }
            }
            catch (Exception)
            {
                group.Open = null;
            }
        }
        var sorted = new List<TreasureGroup>(groups.Values);
        sorted.Sort((a, b) =>
            a.Area != b.Area ? a.Area.CompareTo(b.Area) : a.Type.CompareTo(b.Type));
        var rows = new JsonArray();
        foreach (var group in sorted)
        {
            rows.Add(new JsonObject
            {
                ["area"] = group.Area,
                ["name"] = AreaName(group.Area),
                ["type"] = group.Type,
                ["total"] = group.Total,
                ["open"] = group.Open == null ? null : group.Open.Value,
            });
        }
        return rows;
    }

    /// <summary>The area's name through the message table; null when the master row is missing.</summary>
    private static string AreaName(int areaId)
    {
        try
        {
            var master = Il2CppSystem.SingletonMonoBehaviour<Last.Data.Master.MasterManager>.instance;
            var area = master?.GetData<Last.Data.Master.Area>(areaId);
            var name = area == null ? null : Text(area.AreaName);
            return string.IsNullOrEmpty(name) ? null : name;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>Each member's level and every job's level, with the game's own mastery test.</summary>
    private static JsonNode Members(Il2CppSystem.Collections.Generic.List<Last.Data.User.OwnedCharacterData> owned)
    {
        var provider = Provider();
        var rows = new JsonArray();
        for (var i = 0; i < owned.Count; i++)
        {
            var c = owned[i];
            if (c == null)
            {
                continue;
            }
            var jobs = new JsonArray();
            var jobDataList = c.OwnedJobDataList;
            for (var k = 0; jobDataList != null && k < jobDataList.Count; k++)
            {
                var job = jobDataList[k];
                if (job == null)
                {
                    continue;
                }
                jobs.Add(new JsonObject
                {
                    ["id"] = Read(() => job.Id),
                    ["level"] = Read(() => job.Level),
                    ["mastered"] = Mastered(provider, c, job.Id),
                });
            }
            rows.Add(new JsonObject
            {
                ["id"] = Read(() => c.Id),
                ["name"] = Read(() => c.Name),
                ["level"] = Read(() => c.Parameter?.ConfirmedLevel()),
                ["jobs"] = jobs,
            });
        }
        return rows;
    }

    /// <summary>The released job ids, in the order the game keeps them.</summary>
    private static JsonNode ReleasedJobs(UserDataManager u)
    {
        var jobs = u.ReleasedJobs;
        if (jobs == null)
        {
            return null;
        }
        var ids = new JsonArray();
        for (var i = 0; i < jobs.Count; i++)
        {
            var id = jobs[i]?.Id;
            ids.Add(id);
        }
        return ids;
    }

    /// <summary>
    /// The four scenario-flag banks for every achievement condition that is not a cumulative
    /// count. Only Scenario is decoded today; the other rows are here so Claude can fill the
    /// engine's table from real data (task 13).
    /// </summary>
    private static JsonNode Flags(JsonArray defs)
    {
        if (defs == null)
        {
            return null;
        }
        var storage = Last.Interpreter.DataStorage.instance;
        if (storage == null)
        {
            return null;
        }
        var flags = new JsonObject();
        foreach (var node in defs)
        {
            var def = node as JsonObject;
            var typeName = def?["typeName"]?.GetValue<string>();
            var condition = def?["condition"]?.GetValue<int>();
            if (typeName == null || CountTypes.Contains(typeName) || condition == null)
            {
                continue;
            }
            var key = condition.Value.ToString();
            if (flags.ContainsKey(key))
            {
                continue;
            }
            var banks = new JsonArray();
            foreach (var category in new[]
            {
                Last.Interpreter.DataStorage.Category.kScenarioFlag1,
                Last.Interpreter.DataStorage.Category.kScenarioFlag2,
                Last.Interpreter.DataStorage.Category.kScenarioFlag3,
                Last.Interpreter.DataStorage.Category.kScenarioFlag4,
            })
            {
                banks.Add(Read(() => storage.Get(category, condition.Value)));
            }
            flags[key] = banks;
        }
        return flags;
    }

#if FF5
    private static Serial.Template.Management.JobInfomationProvider Provider()
    {
        try
        {
            return Serial.ProviderManager.instance?.JobInfomationProvider;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static JsonNode Mastered(
        Serial.Template.Management.JobInfomationProvider provider,
        Last.Data.User.OwnedCharacterData character,
        int jobId)
    {
        var data = provider?.serialData;
        if (data == null)
        {
            return null;
        }
        try
        {
            return data.IsJobMaster(character, jobId);
        }
        catch (Exception)
        {
            return null;
        }
    }
#else
    // Job mastery is FF5's (and FF3's, once its assemblies are in): elsewhere `mastered` is null.
    private static object Provider() => null;

    private static JsonNode Mastered(object provider, Last.Data.User.OwnedCharacterData character, int jobId) => null;
#endif

    private sealed class BestiaryRow
    {
        public int Number;
        public string Name;
        public bool Registered;
        public readonly SortedSet<int> Areas = new();
    }

    private sealed class TreasureGroup
    {
        public int Area;
        public int Type;
        public int Total;
        public int? Open = 0;
    }

    private static JsonNode Read(Func<JsonNode> read)
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
