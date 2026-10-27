using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Last.Management;

namespace FfprBridge;

/// <summary>
/// Static monster data for the bestiary page (task 16): one row per bestiary number, using the
/// first PictureBook entry for that number, the Monster master, AttributeGroup, ConditionGroup
/// and Content. Read only; the panel caches this once in the plugin process.
/// </summary>
internal static partial class GameState
{
    private static readonly Regex IconTag = new("<IC_[A-Z_]+>", RegexOptions.Compiled);

    public static JsonArray Monsters()
    {
        var master = Il2CppSystem.SingletonMonoBehaviour<Last.Data.Master.MasterManager>.instance;
        var books = master?.GetList<Last.Data.Master.PictureBook>();
        var groups = Groups();
        if (master == null || books == null || groups.Count == 0)
        {
            return null;
        }
        var attributeGroups = new Dictionary<int, List<Last.Data.Master.AttributeGroup>>();
        var attributeList = master.GetList<Last.Data.Master.AttributeGroup>();
        foreach (var pair in attributeList)
        {
            var row = pair.Value;
            if (row == null)
            {
                continue;
            }
            if (!attributeGroups.TryGetValue(row.GroupId, out var groupRows))
            {
                groupRows = new List<Last.Data.Master.AttributeGroup>();
                attributeGroups[row.GroupId] = groupRows;
            }
            groupRows.Add(row);
        }
        var conditionGroups = new Dictionary<int, List<int>>();
        var conditionGroupList = master.GetList<Last.Data.Master.ConditionGroup>();
        foreach (var pair in conditionGroupList)
        {
            var row = pair.Value;
            if (row == null)
            {
                continue;
            }
            if (!conditionGroups.TryGetValue(row.GroupId, out var ids))
            {
                ids = new List<int>();
                conditionGroups[row.GroupId] = ids;
            }
            ids.Add(row.ConditionId);
        }
        var conditionNames = new Dictionary<int, string>();
        var conditionList = master.GetList<Last.Data.Master.Condition>();
        foreach (var pair in conditionList)
        {
            if (pair.Value != null)
            {
                conditionNames[pair.Key] = Clean(pair.Value.MesIdName);
            }
        }
        var contentNames = new Dictionary<int, string>();
        var contentList = master.GetList<Last.Data.Master.Content>();
        foreach (var pair in contentList)
        {
            if (pair.Value != null)
            {
                contentNames[pair.Key] = Clean(pair.Value.MesIdName);
            }
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
        var seen = new HashSet<int>();
        var rowsByNumber = new Dictionary<int, JsonObject>();
        foreach (var pair in sorted)
        {
            var book = pair.Value;
            if (!groups.TryGetValue(book.Id, out var group) || !seen.Add(group.Group))
            {
                continue;
            }
            Last.Data.Master.Monster monster = null;
            try
            {
                monster = master.GetData<Last.Data.Master.Monster>(book.MonsterId);
            }
            catch (Exception)
            {
            }
            var row = new JsonObject
            {
                ["number"] = group.Group,
                ["monster"] = book.MonsterId,
                ["name"] = monster == null ? null : Read(() => Clean(monster.MesIdName)),
                ["lv"] = monster == null ? null : Read(() => monster.Lv),
                ["hp"] = monster == null ? null : Read(() => monster.Hp),
                ["mp"] = monster == null ? null : Read(() => monster.Mp),
                ["exp"] = monster == null ? null : Read(() => monster.Exp),
                ["gil"] = monster == null ? null : Read(() => monster.Gill),
                ["boss"] = monster == null ? null : Read(() => monster.Boss != 0),
                ["species"] = monster == null ? null : Read(() => monster.Species),
                ["resistanceAttribute"] = monster == null ? null : Read(() => monster.ResistanceAttribute),
                ["attributes"] = monster == null
                    ? null
                    : Read(() => Attributes(monster.ResistanceAttribute, attributeGroups)),
                ["resistanceCondition"] = monster == null ? null : Read(() => monster.ResistanceCondition),
                ["conditions"] = monster == null
                    ? null
                    : Read(() => Conditions(monster.ResistanceCondition, conditionGroups, conditionNames)),
                ["drops"] = monster == null
                    ? null
                    : Read(() => ContentNames(
                        new[]
                        {
                            monster.DropContentId1,
                            monster.DropContentId2,
                            monster.DropContentId3,
                            monster.DropContentId4,
                            monster.DropContentId5,
                            monster.DropContentId6,
                            monster.DropContentId7,
                            monster.DropContentId8,
                        },
                        contentNames)),
                ["steals"] = monster == null
                    ? null
                    : Read(() => ContentNames(
                        new[]
                        {
                            monster.StealContentId1,
                            monster.StealContentId2,
                            monster.StealContentId3,
                            monster.StealContentId4,
                        },
                        contentNames)),
            };
            rowsByNumber[group.Group] = row;
        }
        var numbers = new List<int>(rowsByNumber.Keys);
        numbers.Sort();
        var rows = new JsonArray();
        foreach (var number in numbers)
        {
            rows.Add(rowsByNumber[number]);
        }
        return rows;
    }

    private static JsonArray Attributes(
        int groupId,
        Dictionary<int, List<Last.Data.Master.AttributeGroup>> groups)
    {
        if (!groups.TryGetValue(groupId, out var rows))
        {
            return null;
        }
        var attributes = new JsonArray();
        foreach (var row in rows)
        {
            var type = row.TypeId;
            if (type == 0)
            {
                continue;
            }
            attributes.Add(new JsonObject
            {
                ["id"] = Read(() => row.AttributeId),
                ["name"] = Read(() => Clean(row.MesIdName)),
                ["type"] = type,
            });
        }
        return attributes;
    }

    private static JsonArray Conditions(
        int groupId,
        Dictionary<int, List<int>> groups,
        Dictionary<int, string> names)
    {
        if (!groups.TryGetValue(groupId, out var ids))
        {
            return null;
        }
        var conditions = new JsonArray();
        var seen = new HashSet<string>();
        foreach (var id in ids)
        {
            if (!names.TryGetValue(id, out var name) || string.IsNullOrEmpty(name) || !seen.Add(name))
            {
                continue;
            }
            conditions.Add(name);
        }
        return conditions;
    }

    private static JsonArray ContentNames(IEnumerable<int> ids, Dictionary<int, string> names)
    {
        var contents = new JsonArray();
        var seen = new HashSet<string>();
        foreach (var id in ids)
        {
            if (id <= 0 || !names.TryGetValue(id, out var name) || string.IsNullOrEmpty(name) ||
                !seen.Add(name))
            {
                continue;
            }
            contents.Add(name);
        }
        return contents;
    }

    private static string Clean(string key)
    {
        var text = Text(key);
        if (string.IsNullOrEmpty(text))
        {
            return null;
        }
        return IconTag.Replace(text, "").Trim();
    }
}
