#if FF5
using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using Il2CppInterop.Runtime;
using Last.Data.Master;
using Last.Management;
using Last.Systems;

namespace FfprBridge;

/// <summary>
/// 0.14.4: the moves a monster can use, from Monster.ScriptId -> AI script -> ability ids.
/// Ability ids are resolved through the same parser as monsterai; names use the game's own
/// Ability resolver. Blue magic and statuses are looked up in the master tables. Read only.
/// </summary>
internal static partial class GameState
{
    private sealed class MoveRow
    {
        public JsonObject Node;
        public HashSet<string> Conditions = new();
        public List<string> ConditionOrder = new();
    }

    public static JsonArray MonsterMoves(int[] ids)
    {
        var wanted = ids;
        if (wanted == null || wanted.Length == 0)
        {
            wanted = BattleEnemyIds();
        }
        var rows = new JsonArray();
        var seen = new HashSet<int>();
        foreach (var id in wanted)
        {
            if (id > 0 && seen.Add(id))
            {
                rows.Add(OneMonsterMoves(id));
            }
        }
        return rows;
    }

    private static JsonObject OneMonsterMoves(int id)
    {
        var ai = OneMonsterAi(id);
        var o = new JsonObject { ["id"] = id };
        Copy(ai, o, "name");
        Copy(ai, o, "scriptId");
        Copy(ai, o, "scriptName");
        Copy(ai, o, "source");
        var scriptError = TextValue(ai, "error");
        if (!string.IsNullOrEmpty(scriptError))
        {
            o["error"] = scriptError;
            o["moves"] = null;
            return o;
        }
        var moves = new JsonArray();
        var byAbility = new Dictionary<int, MoveRow>();
        var order = new List<int>();
        var abilities = ai["abilities"] as JsonArray;
        for (var i = 0; abilities != null && i < abilities.Count; i++)
        {
            var ability = abilities[i] as JsonObject;
            if (ability == null)
            {
                continue;
            }
            var abilityId = ability["id"]?.GetValue<int>() ?? 0;
            if (abilityId <= 0)
            {
                continue;
            }
            if (!byAbility.TryGetValue(abilityId, out var move))
            {
                var name = TextValue(ability, "name");
                var learningId = BlueLearningAbility(abilityId);
                var blue = learningId > 0;
                var blueIds = BlueMagicIds(
                    Il2CppSystem.SingletonMonoBehaviour<MasterManager>.instance);
                if (!blue && blueIds != null && blueIds.Contains(abilityId))
                {
                    blue = true;
                    learningId = abilityId;
                }
                move = new MoveRow
                {
                    Node = new JsonObject
                    {
                        ["abilityId"] = abilityId,
                        ["name"] = name,
                        ["blueMagic"] = blue,
                    },
                };
                if (name == null)
                {
                    var key = TextValue(ability, "nameKey");
                    if (!string.IsNullOrEmpty(key))
                    {
                        move.Node["nameKey"] = key;
                    }
                }
                var rate = ToDouble(ability["rate"]);
                if (rate.HasValue)
                {
                    move.Node["rate"] = Math.Round(rate.Value, 3);
                }
                if (blue && learningId > 0 && learningId != abilityId)
                {
                    // This move teaches a different Ability id (e.g. an attack that grants a spell).
                    move.Node["blueMagicId"] = learningId;
                }
                byAbility[abilityId] = move;
                order.Add(abilityId);
            }
            else if (move.Node["rate"] == null)
            {
                // Keep the first rate, but fill it if the first occurrence was in a plain action.
                var rate = ToDouble(ability["rate"]);
                if (rate.HasValue)
                {
                    move.Node["rate"] = Math.Round(rate.Value, 3);
                }
            }
            foreach (var name in MoveConditions(abilityId))
            {
                if (move.Conditions.Add(name))
                {
                    move.ConditionOrder.Add(name);
                }
            }
        }
        foreach (var abilityId in order)
        {
            var move = byAbility[abilityId];
            var conditions = new JsonArray();
            foreach (var name in move.ConditionOrder)
            {
                conditions.Add(name);
            }
            move.Node["conditions"] = conditions;
            moves.Add(move.Node);
        }
        o["moves"] = moves;
        return o;
    }

    /// <summary>
    /// Statuses attached to an ability: Ability.ConditionGroupId -> ConditionGroup.GroupId ->
    /// Condition. The group/condition link is inferred (task 81); names fall back to ConditionType.
    /// Magic's statuses go through Magic.FunctionGroupId, which is not decoded, so they may be
    /// missing here. Never guesses a condition id.
    /// </summary>
    private static List<string> MoveConditions(int abilityId)
    {
        var names = new List<string>();
        try
        {
            var master = Il2CppSystem.SingletonMonoBehaviour<MasterManager>.instance;
            var ability = master?.GetData<Ability>(abilityId);
            if (ability == null || ability.ConditionGroupId <= 0)
            {
                return names;
            }
            var seen = new HashSet<string>();
            var list = GroupMasterUtility.GetConditionMasters(ability.ConditionGroupId);
            for (var i = 0; list != null && i < list.Count; i++)
            {
                var name = ConditionName(list[i]);
                if (!string.IsNullOrEmpty(name) && seen.Add(name))
                {
                    names.Add(name);
                }
            }
            if (names.Count > 0)
            {
                return names;
            }
            // Fallback for a build where GroupMasterUtility's cache is not built yet: walk the
            // two master tables ourselves, matching the field names used by `monsters` (0.7.9).
            var groups = master.GetList<ConditionGroup>();
            foreach (var pair in groups)
            {
                var group = pair.Value;
                if (group == null || group.GroupId != ability.ConditionGroupId)
                {
                    continue;
                }
                var condition = master.GetData<Condition>(group.ConditionId);
                var name = ConditionName(condition);
                if (!string.IsNullOrEmpty(name) && seen.Add(name))
                {
                    names.Add(name);
                }
            }
        }
        catch (Exception)
        {
        }
        return names;
    }

    private static void Copy(JsonObject from, JsonObject to, string key)
    {
        var value = from[key];
        if (value != null)
        {
            to[key] = JsonNode.Parse(value.ToJsonString());
        }
    }

    private static string TextValue(JsonObject o, string key)
    {
        try
        {
            return o[key]?.GetValue<string>();
        }
        catch (Exception)
        {
            return null;
        }
    }
}
#endif
