#if FF5
using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Il2CppInterop.Runtime;
using Last.Battle;
using Last.Battle.AI;
using Last.Data.Master;
using Last.Interpreter.Instructions;
using Last.Management;
using UnityEngine;

namespace FfprBridge;

/// <summary>
/// 0.13.0: monster AI scripts. The Monster master has ScriptId, MonsterAiScript has the asset
/// name, and the battle's InstantiateManager loads the TextAsset. The query reads the script
/// only when asked: no per-frame work and no game state changed.
/// </summary>
internal static partial class GameState
{
    private const int ScriptMax = 4000;

    public static JsonArray MonsterAi(int[] ids)
    {
        AiScriptCache.ScanLoaded();
        var wanted = ids;
        if (wanted == null || wanted.Length == 0)
        {
            wanted = BattleEnemyIds();
        }
        var rows = new JsonArray();
        var seen = new HashSet<int>();
        foreach (var id in wanted)
        {
            if (seen.Add(id))
            {
                rows.Add(OneMonsterAi(id));
            }
        }
        return rows;
    }

    private static int[] BattleEnemyIds()
    {
        var ids = new List<int>();
        var b = BattlePlugManager.instance;
        if (b == null || !b.isBattle)
        {
            return ids.ToArray();
        }
        var list = b.BattleStatusControl?.BattleStatusControlInfo?.battleEnemyDatas;
        for (var i = 0; list != null && i < list.Count; i++)
        {
            var monster = list[i]?.MonsterMaster;
            if (monster != null && !ids.Contains(monster.Id))
            {
                ids.Add(monster.Id);
            }
        }
        return ids.ToArray();
    }

    private static JsonObject OneMonsterAi(int id)
    {
        var o = new JsonObject { ["monster"] = id };
        var master = Il2CppSystem.SingletonMonoBehaviour<MasterManager>.instance;
        if (master == null)
        {
            o["error"] = "主数据还没载入";
            return o;
        }
        Monster monster = null;
        try
        {
            monster = master.GetData<Monster>(id);
        }
        catch (Exception)
        {
        }
        if (monster == null)
        {
            o["error"] = "没有这个怪物编号";
            return o;
        }
        o["name"] = Clean(monster.MesIdName);
        o["scriptId"] = monster.ScriptId;
        MonsterAiScript script = null;
        try
        {
            script = master.GetData<MonsterAiScript>(monster.ScriptId);
        }
        catch (Exception)
        {
        }
        if (script == null)
        {
            o["error"] = "这个怪物没有 AI 脚本记录";
            return o;
        }
        o["scriptName"] = script.ScriptName;
        var raw = AiScriptCache.Get(id);
        var source = raw == null ? "none" : "cache";
        if (raw == null)
        {
            var text = FindScript(monster, script, out source);
            if (text != null && !string.IsNullOrEmpty(text.text))
            {
                raw = text.text;
                AiScriptCache.RememberQuery(id, script.Id, script.ScriptName, raw);
            }
        }
        o["source"] = source;
        if (string.IsNullOrEmpty(raw))
        {
            o["error"] = "脚本没有载入；游戏还没取过这只怪的 AI 脚本";
            return o;
        }
        o["scriptLength"] = raw.Length;
        o["truncated"] = raw.Length > ScriptMax;
        o["script"] = raw.Length > ScriptMax ? raw.Substring(0, ScriptMax) : raw;
        var abilities = ParseAbilities(raw, out var format);
        o["scriptFormat"] = format;
        o["abilities"] = abilities;
        return o;
    }

    /// <summary>
    /// The script usually comes from the battle's InstantiateManager, which already loaded it
    /// for the enemy. If the query names a monster outside the battle, fall back to a loaded
    /// TextAsset with the same name; no asset is loaded by the bridge itself.
    /// </summary>
    private static TextAsset FindScript(Monster monster, MonsterAiScript script, out string source)
    {
        source = "none";
        try
        {
            var instantiate = BattlePlugManager.instance?.InstantiateManager;
            var text = instantiate?.GetEnemyAIScript(monster.Id);
            if (text != null)
            {
                source = "InstantiateManager.GetEnemyAIScript";
                return text;
            }
            if (!string.IsNullOrEmpty(script.ScriptName))
            {
                text = instantiate?.GetAsset<TextAsset>(script.ScriptName);
                if (text != null)
                {
                    source = "InstantiateManager.GetAsset";
                    return text;
                }
            }
        }
        catch (Exception)
        {
        }
        try
        {
            var executes = UnityEngine.Resources.FindObjectsOfTypeAll(Il2CppType.Of<BattleAiExecute>());
            for (var i = 0; executes != null && i < executes.Length; i++)
            {
                var execute = executes[i]?.TryCast<BattleAiExecute>();
                var text = execute?.textAsset;
                if (text != null && SameScript(text, script.ScriptName))
                {
                    source = "BattleAiExecute.textAsset";
                    return text;
                }
            }
        }
        catch (Exception)
        {
        }
        try
        {
            var selectors = UnityEngine.Resources.FindObjectsOfTypeAll(Il2CppType.Of<BattleAiSelectController>());
            for (var i = 0; selectors != null && i < selectors.Length; i++)
            {
                var selector = selectors[i]?.TryCast<BattleAiSelectController>();
                if (selector?.selectedMonsterAiScript == null ||
                    selector.selectedMonsterAiScript.Id != script.Id)
                {
                    continue;
                }
                var text = selector.GetBattleAI();
                if (text != null)
                {
                    source = "BattleAiSelectController.GetBattleAI";
                    return text;
                }
            }
        }
        catch (Exception)
        {
        }
        try
        {
            var assets = UnityEngine.Resources.FindObjectsOfTypeAll(Il2CppType.Of<TextAsset>());
            for (var i = 0; assets != null && i < assets.Length; i++)
            {
                var text = assets[i]?.TryCast<TextAsset>();
                if (text != null && SameScript(text, script.ScriptName))
                {
                    source = "loaded TextAsset";
                    return text;
                }
            }
        }
        catch (Exception)
        {
        }
        return null;
    }

    private static bool SameScript(TextAsset asset, string name)
    {
        if (asset == null || string.IsNullOrEmpty(name) || string.IsNullOrEmpty(asset.name))
        {
            return false;
        }
        return asset.name == name || asset.name.StartsWith(name, StringComparison.Ordinal)
            || name.StartsWith(asset.name, StringComparison.Ordinal);
    }

    private static readonly Regex TextOpcode = new(
        @"^(?:[A-Za-z0-9_]+:\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$", RegexOptions.Compiled);
    private static readonly Regex Number = new(@"-?\d+", RegexOptions.Compiled);

    private static Dictionary<string, int[]> _abilityOperands;

    /// <summary>
    /// Which operand of an AI mnemonic is an ability id. The indices come from the game's own
    /// BattleAI constants (kActForTargetAbilityId and friends), so they follow the build instead
    /// of being guessed. Opcodes without an "AbilityId" constant are left out.
    /// </summary>
    private static Dictionary<string, int[]> AbilityOperands()
    {
        if (_abilityOperands != null)
        {
            return _abilityOperands;
        }
        var map = new Dictionary<string, int[]>(StringComparer.Ordinal);
        void Add(string opcode, params int[] indices)
        {
            if (!string.IsNullOrEmpty(opcode) && indices != null && indices.Length > 0)
            {
                map[opcode] = indices;
            }
        }
        try
        {
            Add(BattleAI.kLoopAct,
                BattleAI.kLoopActAbilityOneId, BattleAI.kLoopActAbilityTwoId,
                BattleAI.kLoopActAbilityThreeId, BattleAI.kLoopActAbilityFourId);
            Add(BattleAI.kActForTarget, BattleAI.kActForTargetAbilityId);
            Add(BattleAI.kActForConditionTargetV2FinalAttack, BattleAI.kActForConditionTargetV2AbilityId);
            Add(BattleAI.kActForGenderTarget, BattleAI.kActForGenderTargetAbilityId);
            Add(BattleAI.kCounterActAttribute, BattleAI.kCounterActAttributeAbilityId);
            Add(BattleAI.kCounterActAttributeMultiAbility, BattleAI.kCounterActAttributeMultiAbilityId);
            Add(BattleAI.kCounterActRecevieAbility, BattleAI.CounterActRecevieAbilityId);
            Add(BattleAI.kCounterActByAbilityRecovery,
                BattleAI.kCounterActByAbilityRecoveryByAbilityId,
                BattleAI.kCounterActByAbilityRecoveryByTargetAbilityId);
            Add(BattleAI.kIsConditionAct, BattleAI.kIsConditionActAbilityId);
            Add(BattleAI.kIsUsedConditionTargetAct, BattleAI.IsUsedConditionTargetActAbilityId);
            Add(BattleAI.kIsRecevieAbility, BattleAI.kIsRecevieAbilityId);
            Add(BattleAI.kIsRecevieAbilitySystem, BattleAI.kIsRecevieAbilitySystemId);
        }
        catch (Exception)
        {
            // The constants are unavailable until the game's own classes are initialized.
            return map;
        }
        if (map.Count > 0)
        {
            _abilityOperands = map;
        }
        return map;
    }

    private static JsonArray ParseAbilities(string raw, out string format)
    {
        format = "unknown";
        var found = new JsonArray();
        var seen = new HashSet<string>();
        var operands = AbilityOperands();

        void AddAbility(int id, string opcode, int? table, double? rate)
        {
            var info = AbilityInfo(id);
            if (id <= 0 || (string.IsNullOrEmpty(info.Name) && string.IsNullOrEmpty(info.Key)))
            {
                return;
            }
            var key = $"{id}|{opcode}|{table}|{rate}";
            if (!seen.Add(key))
            {
                return;
            }
            var row = new JsonObject
            {
                ["id"] = id,
                ["name"] = info.Name,
                ["opcode"] = opcode,
            };
            if (string.IsNullOrEmpty(info.Name) && !string.IsNullOrEmpty(info.Key))
            {
                row["nameKey"] = info.Key;
            }
            if (table.HasValue)
            {
                row["table"] = table.Value;
            }
            else
            {
                row["table"] = null;
            }
            if (rate.HasValue)
            {
                row["rate"] = Math.Round(rate.Value, 3);
            }
            found.Add(row);
        }

        // Act carries one iValue per ability and one rValue per rate:
        //   Act iValues [381, 540] rValues [65, 35]
        // Lists every ability, not just the first.
        void TakeAct(JsonArray values, JsonArray rates, int? table)
        {
            for (var i = 0; values != null && i < values.Count; i++)
            {
                double? rate = rates != null && i < rates.Count ? ToDouble(rates[i]) : null;
                AddAbility(ToInt(values[i]), "Act", table, rate);
            }
        }

        void Take(string opcode, JsonArray values, JsonArray rates, int? table)
        {
            if (opcode == null || values == null)
            {
                return;
            }
            if (string.Equals(opcode, "Act", StringComparison.OrdinalIgnoreCase))
            {
                TakeAct(values, rates, table);
                return;
            }
            if (!operands.TryGetValue(opcode, out var indices))
            {
                return;
            }
            foreach (var index in indices)
            {
                if (index < 0 || index >= values.Count)
                {
                    continue;
                }
                AddAbility(ToInt(values[index]), opcode, table, null);
            }
        }

        JsonArray mnemonics = null;
        try
        {
            var root = JsonNode.Parse(raw);
            mnemonics = FindArray(root, "Mnemonics", 2) ?? root as JsonArray;
            if (mnemonics != null)
            {
                format = "json";
            }
        }
        catch (JsonException)
        {
        }
        catch (Exception)
        {
        }
        if (mnemonics != null)
        {
            var known = 0;
            var nextTable = 0;
            int? table = null;
            foreach (var node in mnemonics)
            {
                var mnemonic = node as JsonObject;
                if (mnemonic == null)
                {
                    continue;
                }
                var opcode = Text(mnemonic, "mnemonic");
                if (string.Equals(opcode, "StartTable", StringComparison.OrdinalIgnoreCase))
                {
                    table = nextTable++;
                    known++;
                    continue;
                }
                if (string.Equals(opcode, "EndTable", StringComparison.OrdinalIgnoreCase))
                {
                    table = null;
                    known++;
                    continue;
                }
                var box = mnemonic["operands"] as JsonObject ?? mnemonic["Operands"] as JsonObject;
                var values = box == null ? null : FindArray(box, "iValues", 0);
                var rates = box == null ? null : FindArray(box, "rValues", 0);
                if (opcode == null || values == null)
                {
                    continue;
                }
                if (operands.ContainsKey(opcode) || string.Equals(opcode, "Act", StringComparison.OrdinalIgnoreCase))
                {
                    known++;
                }
                Take(opcode, values, rates, table);
            }
            if (known == 0)
            {
                format = "json (no recognized opcodes)";
            }
            if (found.Count > 0)
            {
                return found;
            }
        }

        // Some builds may hand out a line-oriented text asset instead of JSON. Try the common
        // "Opcode 1, 2, 3" form; if nothing matches, report unknown rather than guessing.
        if (format == "unknown")
        {
            format = "text";
        }
        int? textTable = null;
        var textNextTable = 0;
        foreach (var line in raw.Split('\n'))
        {
            var text = line.Trim();
            if (text.Length == 0 || text.StartsWith("#") || text.StartsWith("//"))
            {
                continue;
            }
            var match = TextOpcode.Match(text);
            if (!match.Success)
            {
                continue;
            }
            var opcode = match.Groups[1].Value;
            if (string.Equals(opcode, "StartTable", StringComparison.OrdinalIgnoreCase))
            {
                textTable = textNextTable++;
                continue;
            }
            if (string.Equals(opcode, "EndTable", StringComparison.OrdinalIgnoreCase))
            {
                textTable = null;
                continue;
            }
            if (!operands.ContainsKey(opcode) && !string.Equals(opcode, "Act", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            var numbers = new JsonArray();
            foreach (Match number in Number.Matches(match.Groups[2].Value))
            {
                numbers.Add(int.Parse(number.Value));
            }
            Take(opcode, numbers, null, textTable);
        }
        return found;
    }

    private static JsonArray FindArray(JsonNode node, string name, int depth)
    {
        if (node is JsonObject o)
        {
            foreach (var pair in o)
            {
                if (string.Equals(pair.Key, name, StringComparison.OrdinalIgnoreCase) &&
                    pair.Value is JsonArray direct)
                {
                    return direct;
                }
            }
            if (depth > 0)
            {
                foreach (var pair in o)
                {
                    var found = FindArray(pair.Value, name, depth - 1);
                    if (found != null)
                    {
                        return found;
                    }
                }
            }
        }
        else if (node is JsonArray array && depth > 0)
        {
            foreach (var item in array)
            {
                var found = FindArray(item, name, depth - 1);
                if (found != null)
                {
                    return found;
                }
            }
        }
        return null;
    }

    private static string Text(JsonObject o, string key)
    {
        foreach (var pair in o)
        {
            if (!string.Equals(pair.Key, key, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            try
            {
                return pair.Value?.GetValue<string>();
            }
            catch (Exception)
            {
                return null;
            }
        }
        return null;
    }

    private static double? ToDouble(JsonNode node)
    {
        try
        {
            return node?.GetValue<double>();
        }
        catch (Exception)
        {
            try
            {
                return node?.GetValue<int>();
            }
            catch (Exception)
            {
                return null;
            }
        }
    }

    private static int ToInt(JsonNode node)
    {
        try
        {
            return node?.GetValue<int>() ?? 0;
        }
        catch (Exception)
        {
            return 0;
        }
    }
}

/// <summary>
/// 0.13.1: the game sometimes keeps the AI TextAsset in its own loader and does not return it
/// from InstantiateManager.GetEnemyAIScript during battle. Hook the methods the game itself
/// calls and keep the text by script id; monsterai then works after the battle too.
/// </summary>
internal static class AiScriptCache
{
    private sealed class Entry
    {
        public int ScriptId;
        public string ScriptName;
        public string Text;
        public int Length;
    }

    private static readonly Dictionary<int, Entry> ByMonster = new();
    private static Dictionary<string, int> _scriptIds;
    private static readonly Dictionary<int, int> MonsterByScript = new();
    private static int _lastScanFrame = -1;

    public static string Get(int monsterId)
    {
        lock (ByMonster)
        {
            return ByMonster.TryGetValue(monsterId, out var entry) ? entry.Text : null;
        }
    }

    /// <summary>
    /// 0.13.3: called only from the monsterai query, never from a loader hook. Read the
    /// TextAsset already held by live BattleAiExecute objects and any already loaded TextAsset;
    /// never start a load or touch a setter.
    /// </summary>
    public static void ScanLoaded()
    {
        if (_lastScanFrame == Probe.Frame)
        {
            return;
        }
        _lastScanFrame = Probe.Frame;
        try
        {
            var executes = UnityEngine.Resources.FindObjectsOfTypeAll(Il2CppType.Of<BattleAiExecute>());
            for (var i = 0; executes != null && i < executes.Length; i++)
            {
                RememberAsset(executes[i]?.TryCast<BattleAiExecute>()?.textAsset);
            }
        }
        catch (Exception)
        {
        }
        try
        {
            var assets = UnityEngine.Resources.FindObjectsOfTypeAll(Il2CppType.Of<TextAsset>());
            for (var i = 0; assets != null && i < assets.Length; i++)
            {
                RememberAsset(assets[i]?.TryCast<TextAsset>());
            }
        }
        catch (Exception)
        {
        }
    }

    private static void RememberAsset(TextAsset text)
    {
        if (text == null)
        {
            return;
        }
        var scriptId = ScriptIdOfName(text.name);
        if (scriptId <= 0)
        {
            return;
        }
        var monsterId = MonsterIdOfScript(scriptId);
        if (monsterId > 0)
        {
            Remember(monsterId, scriptId, text.name, text.text, true);
        }
    }

    public static void RememberMonster(int monsterId, TextAsset text)
    {
        if (text == null || string.IsNullOrEmpty(text.text))
        {
            return;
        }
        try
        {
            var master = Il2CppSystem.SingletonMonoBehaviour<MasterManager>.instance;
            var monster = master?.GetData<Monster>(monsterId);
            if (monster != null)
            {
                Remember(monsterId, monster.ScriptId, text.name, text.text, true);
            }
        }
        catch (Exception)
        {
        }
    }

    public static void RememberUnique(int uniqueId, TextAsset text)
    {
        if (text == null || string.IsNullOrEmpty(text.text))
        {
            return;
        }
        try
        {
            var monsterId = MonsterIdOfUnique(uniqueId);
            if (monsterId > 0)
            {
                RememberMonster(monsterId, text);
                return;
            }
            RememberAsset(text);
        }
        catch (Exception)
        {
        }
    }

    public static void RememberScript(int scriptId, string scriptName, TextAsset text)
    {
        if (text == null || string.IsNullOrEmpty(text.text) || scriptId <= 0)
        {
            return;
        }
        try
        {
            var monsterId = MonsterIdOfScript(scriptId);
            if (monsterId > 0)
            {
                Remember(monsterId, scriptId,
                    string.IsNullOrEmpty(scriptName) ? text.name : scriptName, text.text, true);
            }
        }
        catch (Exception)
        {
        }
    }

    public static void RememberQuery(int monsterId, int scriptId, string scriptName, string text)
    {
        try
        {
            Remember(monsterId, scriptId, scriptName, text, false);
        }
        catch (Exception)
        {
        }
    }

    private static void Remember(int monsterId, int scriptId, string scriptName, string text, bool emit)
    {
        if (monsterId <= 0 || scriptId <= 0 || string.IsNullOrEmpty(text))
        {
            return;
        }
        var name = scriptName;
        if (string.IsNullOrEmpty(name))
        {
            try
            {
                var master = Il2CppSystem.SingletonMonoBehaviour<MasterManager>.instance;
                name = master?.GetData<MonsterAiScript>(scriptId)?.ScriptName;
            }
            catch (Exception)
            {
            }
        }
        var added = false;
        var length = text.Length;
        lock (ByMonster)
        {
            if (!ByMonster.ContainsKey(monsterId))
            {
                ByMonster[monsterId] = new Entry
                {
                    ScriptId = scriptId,
                    ScriptName = name,
                    Text = text,
                    Length = length,
                };
                added = true;
            }
        }
        if (!added)
        {
            return;
        }
        Emit.Event("battle.ai", o =>
        {
            o["monster"] = monsterId;
            o["scriptId"] = scriptId;
            o["scriptName"] = name;
            o["length"] = length;
        });
    }

    private static int MonsterIdOfUnique(int uniqueId)
    {
        var list = BattlePlugManager.instance?.BattleStatusControl?.BattleStatusControlInfo?.battleEnemyDatas;
        for (var i = 0; list != null && i < list.Count; i++)
        {
            var enemy = list[i];
            if (enemy != null && enemy.UniqueId == uniqueId)
            {
                return enemy.MonsterMaster?.Id ?? 0;
            }
        }
        return 0;
    }

    private static int ScriptIdOfName(string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return 0;
        }
        if (_scriptIds == null)
        {
            var ids = new Dictionary<string, int>(StringComparer.Ordinal);
            try
            {
                var master = Il2CppSystem.SingletonMonoBehaviour<MasterManager>.instance;
                var scripts = master?.GetList<MonsterAiScript>();
                if (scripts != null)
                {
                    foreach (var pair in scripts)
                    {
                        var script = pair.Value;
                        if (script != null && !string.IsNullOrEmpty(script.ScriptName))
                        {
                            ids[script.ScriptName] = script.Id;
                        }
                    }
                }
            }
            catch (Exception)
            {
            }
            if (ids.Count > 0)
            {
                _scriptIds = ids;
            }
        }
        if (_scriptIds == null)
        {
            return 0;
        }
        if (_scriptIds.TryGetValue(name, out var found))
        {
            return found;
        }
        // TextAsset.name can carry a suffix; accept a unique prefix match as a fallback.
        foreach (var pair in _scriptIds)
        {
            if (name.StartsWith(pair.Key, StringComparison.Ordinal) ||
                pair.Key.StartsWith(name, StringComparison.Ordinal))
            {
                return pair.Value;
            }
        }
        return 0;
    }

    private static int MonsterIdOfScript(int scriptId)
    {
        lock (MonsterByScript)
        {
            if (MonsterByScript.TryGetValue(scriptId, out var cached))
            {
                return cached;
            }
        }
        var found = 0;
        try
        {
            var master = Il2CppSystem.SingletonMonoBehaviour<MasterManager>.instance;
            foreach (var pair in master?.GetList<Monster>())
            {
                var monster = pair.Value;
                if (monster != null && monster.ScriptId == scriptId)
                {
                    found = monster.Id;
                    break;
                }
            }
        }
        catch (Exception)
        {
        }
        if (found > 0)
        {
            lock (MonsterByScript)
            {
                MonsterByScript[scriptId] = found;
            }
        }
        return found;
    }
}

#endif
