using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using Il2CppInterop.Runtime.InteropTypes.Arrays;
using Last.Battle;
using Last.Systems;

namespace FfprBridge;

/// <summary>
/// 0.13.0: one battle action and its per-target results. The game's BattleActData is the
/// action; BattleActLog.AddLog receives the finished per-target calc results. Both hooks only
/// read these objects.
/// </summary>
internal static partial class GameState
{
    /// <summary>Enemy or player unit as the events and queries show it: side, name, id, HP.</summary>
    private static JsonObject UnitRef(BattleUnitData unit)
    {
        if (unit == null)
        {
            return null;
        }
        var o = new JsonObject();
        var enemy = unit.TryCast<BattleEnemyData>();
        if (enemy != null)
        {
            var monster = enemy.MonsterMaster;
            o["side"] = "enemy";
            o["name"] = monster == null ? null : Clean(monster.MesIdName);
            o["id"] = monster?.Id;
            // 0.13.6: the bestiary number, so a battle.hit can register a kill by the same
            // number the achievements bestiary uses.
            if (monster != null)
            {
                o["book"] = BookNumber(monster.Id);
            }
        }
        else
        {
            var player = unit.TryCast<BattlePlayerData>();
            var character = player?.ownedCharacterData;
            o["side"] = "player";
            o["name"] = character?.Name;
            o["id"] = character?.Id;
        }
        try
        {
            var parameter = unit.BattleUnitDataInfo?.Parameter;
            if (parameter != null)
            {
                o["hp"] = parameter.CurrentHP;
                o["maxHp"] = parameter.ConfirmedMaxHp();
            }
        }
        catch (Exception)
        {
            // A unit that is going away has no parameter; the identity above is enough.
        }
        return o;
    }

    private static JsonArray UnitRefs(Il2CppReferenceArray<BattleUnitData> units)
    {
        if (units == null)
        {
            return null;
        }
        var rows = new JsonArray();
        for (var i = 0; i < units.Length; i++)
        {
            var row = UnitRef(units[i]);
            if (row != null)
            {
                rows.Add(row);
            }
        }
        return rows;
    }

    private static JsonObject CommandRef(Last.Data.Master.Command command)
    {
        if (command == null)
        {
            return null;
        }
        return new JsonObject
        {
            ["id"] = command.Id,
            ["name"] = Clean(command.MesIdName),
        };
    }

    private static JsonArray AbilityRefs(Il2CppSystem.Collections.Generic.List<Last.Data.Master.Ability> list)
    {
        if (list == null || list.Count == 0)
        {
            return null;
        }
        var rows = new JsonArray();
        for (var i = 0; i < list.Count; i++)
        {
            var ability = list[i];
            if (ability == null)
            {
                continue;
            }
            var info = AbilityInfo(ability.Id);
            var row = new JsonObject
            {
                ["id"] = ability.Id,
                ["name"] = info.Name,
            };
            if (string.IsNullOrEmpty(info.Name) && !string.IsNullOrEmpty(info.Key))
            {
                row["nameKey"] = info.Key;
            }
            rows.Add(row);
        }
        return rows.Count == 0 ? null : rows;
    }

    private static JsonArray ItemRefs(Il2CppSystem.Collections.Generic.List<Last.Data.User.OwnedItemData> list)
    {
        if (list == null || list.Count == 0)
        {
            return null;
        }
        var rows = new JsonArray();
        for (var i = 0; i < list.Count; i++)
        {
            var item = list[i];
            if (item == null)
            {
                continue;
            }
            rows.Add(new JsonObject
            {
                ["id"] = item.ContentId,
                ["name"] = item.Name,
            });
        }
        return rows.Count == 0 ? null : rows;
    }

    /// <summary>The action as battle.act and battle.hit carry it.</summary>
    public static void FillBattleAct(JsonObject o, BattleActData act)
    {
        o["actor"] = UnitRef(act.AttackUnitData);
        o["command"] = CommandRef(act.Command);
        o["abilities"] = AbilityRefs(act.abilityList);
        o["items"] = ItemRefs(act.itemList);
        o["targets"] = UnitRefs(act.TargetUnitDatas);
        o["act"] = act.CurrentActType.ToString();
        o["use"] = act.CurrentUseType.ToString();
        o["targetType"] = act.CurrentTargetType.ToString();
#if FF5
        o["counter"] = act.isCounter;
        o["counterCount"] = act.counterCount;
#elif FF6
        o["counter"] = act.isCounter;
        o["counterCount"] = null;
#else
        // FF1-FF4 have neither isCounter nor counterCount on BattleActData.
        o["counter"] = null;
        o["counterCount"] = null;
#endif
    }

    /// <summary>The short action summary repeated on every battle.hit record.</summary>
    private static JsonObject ActBrief(BattleActData act)
    {
        return new JsonObject
        {
            ["actor"] = UnitRef(act.AttackUnitData),
            ["command"] = CommandRef(act.Command),
            ["abilities"] = AbilityRefs(act.abilityList),
#if FF5 || FF6
            ["counter"] = act.isCounter,
#else
            ["counter"] = null,
#endif
        };
    }

    /// <summary>
    /// One battle.hit per target. BattleActLog.AddLog is called once when an action's effect has
    /// been calculated for every target, and its dictionary holds each target's ICalcResult.
    /// </summary>
    public static void EmitBattleHits(
        BattleActData act, Il2CppSystem.Collections.Generic.Dictionary<BattleUnitData, ICalcResult> results)
    {
        if (results == null || results.Count == 0)
        {
            return;
        }
        foreach (var pair in results)
        {
            try
            {
                var target = UnitRef(pair.Key);
                var calc = pair.Value;
                if (target == null || calc == null)
                {
                    continue;
                }
                var hit = calc.GetHitType().ToString();
                var removed = hit == "RecoveryCondition";
                var conditions = new JsonArray();
                var list = calc.GetConditions();
                var seen = new HashSet<string>();
                for (var i = 0; list != null && i < list.Count; i++)
                {
                    var name = Clean(list[i]?.MesIdName);
                    if (string.IsNullOrEmpty(name) || !seen.Add(name))
                    {
                        continue;
                    }
                    conditions.Add(new JsonObject
                    {
                        ["name"] = name,
                        ["change"] = removed ? "remove" : "add",
                    });
                }
                Emit.Event("battle.hit", o =>
                {
                    o["act"] = ActBrief(act);
                    o["target"] = target;
                    o["value"] = calc.GetValue();
                    o["hit"] = hit;
                    o["hitCount"] = calc.GetHitCount();
                    o["miss"] = hit == "Miss";
                    o["heal"] = hit == "Recovery" || hit == "MPRecovery" || hit == "RecoveryCondition";
                    if (conditions.Count > 0)
                    {
                        o["conditions"] = conditions;
                    }
                });
            }
            catch (Exception e)
            {
                // One broken target must not stop the rest of the action's events.
                HookErrors.Failed("BattleHit", e);
            }
        }
    }

    private static readonly Dictionary<int, (string Name, string Key)> _abilityCache = new();
    private static Dictionary<int, string> _abilityKeys;

    /// <summary>
    /// 0.13.2: name and raw text key. The key is kept when the text table has no Chinese, so the
    /// caller can emit name=null + nameKey instead of treating "None" as a name.
    /// </summary>
    private static (string Name, string Key) AbilityInfo(int id)
    {
        if (id <= 0)
        {
            return (null, null);
        }
        lock (_abilityCache)
        {
            if (_abilityCache.TryGetValue(id, out var cached))
            {
                return cached;
            }
        }
        var info = ResolveAbility(id);
        if (!string.IsNullOrEmpty(info.Name) || !string.IsNullOrEmpty(info.Key))
        {
            lock (_abilityCache)
            {
                _abilityCache[id] = info;
            }
        }
        return info;
    }

    private static bool Blank(string value)
    {
        return string.IsNullOrEmpty(value) || string.Equals(value, "None", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Resolve a message key; null when the text table has no entry.</summary>
    private static string TryText(string key)
    {
        if (Blank(key))
        {
            return null;
        }
        var text = Clean(Text(key));
        return Blank(text) || text == key ? null : text;
    }

    private static (string Name, string Key) ResolveAbility(int id)
    {
        // The game's own resolver first.
        try
        {
            var name = Last.Systems.ContentUtitlity.GetAbilityName(id);
            if (!Blank(name))
            {
                if (name.IndexOf('_') >= 0)
                {
                    var text = TryText(name);
                    if (!Blank(text))
                    {
                        return (text, name);
                    }
                    return (null, name);
                }
                var plain = Clean(name);
                if (!Blank(plain))
                {
                    return (plain, null);
                }
            }
        }
        catch (Exception)
        {
        }
        // The name field, then the battle field (MSG_MON_ATK_* for monster-only abilities).
        try
        {
            var key = Last.Systems.ContentUtitlity.GetMesIdAbilityName(id);
            if (!Blank(key))
            {
                return (TryText(key), key);
            }
        }
        catch (Exception)
        {
        }
        try
        {
            var key = Last.Systems.ContentUtitlity.GetMesIdBattle(id);
            if (!Blank(key))
            {
                return (TryText(key), key);
            }
        }
        catch (Exception)
        {
        }
        // Walk Content for the id. Monster-only rows often have MesIdName="None" and the real
        // text in MesIdBattle.
        if (_abilityKeys == null)
        {
            var battleKeys = new Dictionary<int, string>();
            var plainKeys = new Dictionary<int, string>();
            try
            {
                var master = Il2CppSystem.SingletonMonoBehaviour<Last.Data.Master.MasterManager>.instance;
                var contents = master?.GetList<Last.Data.Master.Content>();
                if (contents != null)
                {
                    foreach (var pair in contents)
                    {
                        var content = pair.Value;
                        if (content == null)
                        {
                            continue;
                        }
                        AddContentKey(battleKeys, content.TypeValue, content.Id, content.MesIdBattle);
                        AddContentKey(plainKeys, content.TypeValue, content.Id, content.MesIdName);
                    }
                }
            }
            catch (Exception)
            {
            }
            foreach (var pair in plainKeys)
            {
                if (!battleKeys.ContainsKey(pair.Key))
                {
                    battleKeys[pair.Key] = pair.Value;
                }
            }
            if (battleKeys.Count > 0)
            {
                _abilityKeys = battleKeys;
            }
        }
        if (_abilityKeys != null && _abilityKeys.TryGetValue(id, out var rawKey))
        {
            return (TryText(rawKey), rawKey);
        }
        return (null, null);
    }

    private static void AddContentKey(Dictionary<int, string> map, int typeValue, int id, string key)
    {
        if (Blank(key))
        {
            return;
        }
        if (!map.ContainsKey(typeValue))
        {
            map[typeValue] = key;
        }
        if (!map.ContainsKey(id))
        {
            map[id] = key;
        }
    }
}
