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

/// <summary>The party and the inventory.</summary>
internal static partial class GameState
{
    /// <summary>
    /// The party in slot order. GetPartyMemberData() returned null throughout the first probe
    /// session, so join the corps slots to the owned characters ourselves.
    /// </summary>
    private static JsonNode Party()
    {
        var u = UserDataManager.instance;
        var corps = u?.corpsList;
        var owned = u?.OwnedCharacterList;
        if (corps == null || owned == null)
        {
            return null;
        }
        var byId = new Dictionary<int, Last.Data.User.OwnedCharacterData>();
        for (var i = 0; i < owned.Count; i++)
        {
            var c = owned[i];
            if (c != null)
            {
                byId[c.Id] = c;
            }
        }
        var party = new JsonArray();
        for (var i = 0; i < corps.Count; i++)
        {
            var slot = corps[i];
            if (slot == null || !byId.TryGetValue(slot.CharacterId, out var c))
            {
                continue;
            }
            var p = c.Parameter;
            party.Add(new JsonObject
            {
                ["slot"] = slot.Id.ToString(),
                ["id"] = c.Id,
                ["name"] = c.Name,
                ["job"] = c.JobId,
                ["jobName"] = JobName(c.JobId),
                // 0.7.5: OwnedJob is the character's current job data, so its Level is the
                // level of the job shown above.
                ["jobLevel"] = c.OwnedJob?.Level,
                ["lv"] = p?.ConfirmedLevel(),
                ["hp"] = p?.CurrentHP,
                ["maxHp"] = p?.ConfirmedMaxHp(),
                ["mp"] = p?.CurrentMP,
                ["maxMp"] = p?.ConfirmedMaxMp(),
                ["exp"] = c.CurrentExp,
                ["status"] = Conditions(p?.CurrentConditionList),
                ["abilities"] = Abilities(c.OwnedAbilityList),
            });
        }
        return party;
    }

    /// <summary>
    /// 0.7.4: what the character has learned, by name with its type and MP cost, so the
    /// tactician's fact sheet can name real spells instead of only 最强 (10-27: it wrote tables
    /// blind to who knows 救疗 or 冰冻). Null when there are none.
    /// </summary>
    private static JsonArray Abilities(Il2CppSystem.Collections.Generic.List<Last.Data.User.OwnedAbility> list)
    {
        if (list == null || list.Count == 0)
        {
            return null;
        }
        var rows = new JsonArray();
        for (var i = 0; i < list.Count; i++)
        {
            var a = list[i];
            if (a?.Ability == null)
            {
                continue;
            }
            rows.Add(new JsonObject
            {
                ["id"] = a.Ability.Id,
                ["name"] = Text(a.MesIdName),
                ["type"] = a.Ability.TypeId,
                ["group"] = a.Ability.AbilityGroupId,
                ["mp"] = a.Ability.UseValue,
            });
        }
        return rows;
    }

    /// <summary>
    /// Status conditions by their game names (毒, 石化 ...); null when there are none. 0.6.5:
    /// on the field too, since poison stays after a battle and nobody saw it (10-20).
    /// </summary>
    private static JsonArray Conditions(Il2CppSystem.Collections.Generic.List<Last.Data.Master.Condition> list)
    {
        if (list == null || list.Count == 0)
        {
            return null;
        }
        var names = new JsonArray();
        for (var k = 0; k < list.Count; k++)
        {
            var c = list[k];
            if (c != null)
            {
                // The condition masters' names read empty (10-20: poison showed as ""), so the
                // type's name (Poison, Mineralization ...) is sent; the dev box translates it.
                var text = Text(c.MesIdName);
                var type = Enum.GetName(typeof(Last.Defaine.ConditionType), c.ConditionType);
                names.Add(!string.IsNullOrEmpty(text) ? text : type ?? $"#{c.ConditionType}");
            }
        }
        return names;
    }

    private static readonly Dictionary<int, string> JobNames = new();

    /// <summary>The job's name from the job master (白魔法师), cached; null if it cannot be read.</summary>
    private static string JobName(int id)
    {
        if (JobNames.TryGetValue(id, out var name))
        {
            return name;
        }
        try
        {
            var master = Il2CppSystem.SingletonMonoBehaviour<Last.Data.Master.MasterManager>.instance;
            name = Text(master?.GetData<Last.Data.Master.Job>(id)?.MesIdName);
        }
        catch (Exception)
        {
            name = null;
        }
        if (name != null)
        {
            JobNames[id] = name;
        }
        return name;
    }

    private static readonly Dictionary<string, int> JobIdsByName = new();

    /// <summary>
    /// The job id for a name shown in the job grid. The grid cells do not expose their id
    /// (JobContentController.SetData passes it straight to the native controller), so scan the
    /// job master once and remember the names. Null until the master has loaded.
    /// </summary>
    private static int? JobIdByName(string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return null;
        }
        if (JobIdsByName.Count == 0)
        {
            for (var id = 0; id < 32; id++)
            {
                var jobName = JobName(id);
                if (!string.IsNullOrEmpty(jobName))
                {
                    JobIdsByName[jobName] = id;
                }
            }
        }
        return JobIdsByName.TryGetValue(name, out var found) ? found : null;
    }

    /// <summary>Normal items in the order the game keeps them, plus key items.</summary>
    public static JsonObject Items()
    {
        var u = UserDataManager.instance;
        if (u == null)
        {
            return null;
        }
        JsonArray List(Il2CppSystem.Collections.Generic.List<Last.Data.User.OwnedItemData> items)
        {
            var array = new JsonArray();
            for (var i = 0; items != null && i < items.Count; i++)
            {
                var item = items[i];
                if (item == null || item.Count <= 0)
                {
                    continue;
                }
                array.Add(new JsonObject
                {
                    ["id"] = item.ContentId,
                    ["name"] = item.Name,
                    ["count"] = item.Count,
                    ["sort"] = item.SortId,
                    // 0.6.8: Item, Weapon, Armor ...: new gear can then be put on (10-21).
                    ["type"] = Enum.GetName(typeof(Last.Defaine.Content.ContentType), item.TypeId),
                });
            }
            return array;
        }
        return new JsonObject
        {
            ["normal"] = List(u.GetOwnedItemsClone()),
            ["important"] = List(u.GetImportantOwnedItemsClone()),
        };
    }
}
