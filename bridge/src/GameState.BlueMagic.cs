#if FF5
using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using Il2CppInterop.Runtime;
using Last.Data.Master;
using Last.Data.User;
using Last.Management;
using Last.Systems;

namespace FfprBridge;

/// <summary>
/// 0.14.4: FF5 blue magic. The game has no dedicated "learned blue magic" list: a blue spell is
/// an Ability with TypeId == AbilityType.BlueMagic (504), and a character that learned it keeps
/// it in OwnedCharacterData.OwnedAbilityList. The Ability master is the list of all blue spells;
/// Learning rows only explain how a spell is learned. Read only.
/// </summary>
internal static partial class GameState
{
    private const int BlueMagicType = (int)Last.Defaine.Master.AbilityType.BlueMagic;
    private static HashSet<int> _blueMagicIds;

    /// <summary>The bluemagic query: learned rows plus every blue spell in the master.</summary>
    public static JsonObject BlueMagic()
    {
        var o = new JsonObject();
        var master = Il2CppSystem.SingletonMonoBehaviour<MasterManager>.instance;
        if (master == null)
        {
            o["learned"] = null;
            o["all"] = null;
            o["error"] = "主数据还没载入";
            return o;
        }
        var all = BlueMagicAll(master);
        o["all"] = all;
        o["learned"] = BlueMagicLearned(all);
        return o;
    }

    /// <summary>
    /// All blue magic in the Ability master, with a short learning note. The note comes from the
    /// Learning master when it has a matching row; otherwise the FF5 rule (a monster uses it while
    /// a character with 学习 is hit) is written. The Learning field semantics are inferred.
    /// </summary>
    private static JsonArray BlueMagicAll(MasterManager master)
    {
        var ids = BlueMagicIds(master);
        if (ids == null)
        {
            return null;
        }
        var methods = LearningMethods(master);
        var sorted = new List<int>(ids);
        sorted.Sort();
        var rows = new JsonArray();
        foreach (var id in sorted)
        {
            var info = AbilityInfo(id);
            var learnedBy = methods.TryGetValue(id, out var method)
                ? method
                : "怪物施放（青魔法师带「学习」）";
            rows.Add(new JsonObject
            {
                ["id"] = id,
                ["name"] = info.Name,
                ["learnedBy"] = learnedBy,
            });
        }
        return rows;
    }

    /// <summary>
    /// Blue spells the party has learned: every owned character's OwnedAbilityList filtered by
    /// Ability.TypeId. Null when the user data or all character ability lists are unreadable;
    /// an empty array means the save was read and nothing is learned yet.
    /// </summary>
    private static JsonArray BlueMagicLearned(JsonArray all)
    {
        var u = UserDataManager.instance;
        var characters = u?.OwnedCharacterList;
        if (characters == null)
        {
            return null;
        }
        var names = new Dictionary<int, string>();
        for (var i = 0; all != null && i < all.Count; i++)
        {
            var row = all[i] as JsonObject;
            if (row == null)
            {
                continue;
            }
            var id = row["id"]?.GetValue<int>() ?? 0;
            if (id > 0)
            {
                names[id] = row["name"]?.GetValue<string>();
            }
        }
        var learned = new HashSet<int>();
        var readable = false;
        for (var i = 0; i < characters.Count; i++)
        {
            var character = characters[i];
            if (character == null)
            {
                continue;
            }
            readable = true;
            try
            {
                var abilities = character.OwnedAbilityList;
                for (var k = 0; abilities != null && k < abilities.Count; k++)
                {
                    var ability = abilities[k]?.Ability;
                    if (ability != null && ability.TypeId == BlueMagicType)
                    {
                        learned.Add(ability.Id);
                    }
                }
            }
            catch (Exception)
            {
                // One character with an unreadable list must not hide the others.
            }
        }
        if (!readable)
        {
            return null;
        }
        var sorted = new List<int>(learned);
        sorted.Sort();
        var rows = new JsonArray();
        foreach (var id in sorted)
        {
            if (!names.TryGetValue(id, out var name))
            {
                name = AbilityInfo(id).Name;
            }
            rows.Add(new JsonObject
            {
                ["id"] = id,
                ["name"] = name,
            });
        }
        return rows;
    }

    /// <summary>Blue Ability ids from the master; null until the master has loaded.</summary>
    private static HashSet<int> BlueMagicIds(MasterManager master)
    {
        if (_blueMagicIds != null)
        {
            return _blueMagicIds;
        }
        var ids = new HashSet<int>();
        try
        {
            foreach (var pair in master.GetList<Ability>())
            {
                var ability = pair.Value;
                if (ability != null && ability.TypeId == BlueMagicType)
                {
                    ids.Add(ability.Id);
                }
            }
        }
        catch (Exception)
        {
            return null;
        }
        if (ids.Count > 0)
        {
            _blueMagicIds = ids;
        }
        return ids;
    }

    /// <summary>
    /// Learning rows by the ability they teach. Learning.ContentId may be a Content row id; map
    /// it to Content.TypeValue (the ability id) when possible. Multiple rows are joined.
    /// </summary>
    private static Dictionary<int, string> LearningMethods(MasterManager master)
    {
        var result = new Dictionary<int, string>();
        try
        {
            var contentToAbility = new Dictionary<int, int>();
            var contents = master.GetList<Content>();
            foreach (var pair in contents)
            {
                var content = pair.Value;
                if (content != null && content.TypeId == (int)Last.Defaine.Content.ContentType.Ability)
                {
                    contentToAbility[content.Id] = content.TypeValue;
                }
            }
            var learnings = master.GetList<Learning>();
            foreach (var pair in learnings)
            {
                var learning = pair.Value;
                if (learning == null)
                {
                    continue;
                }
                var abilityId = contentToAbility.TryGetValue(learning.ContentId, out var mapped)
                    ? mapped
                    : learning.ContentId;
                if (abilityId <= 0)
                {
                    continue;
                }
                var text = LearningText(learning);
                if (!result.TryGetValue(abilityId, out var old))
                {
                    result[abilityId] = text;
                }
                else if (old.IndexOf(text, StringComparison.Ordinal) < 0)
                {
                    result[abilityId] = old + "、" + text;
                }
            }
        }
        catch (Exception)
        {
        }
        return result;
    }

    /// <summary>
    /// A short learning note. TypeId follows Last.Systems.LearningType; what Value1/Value2 mean
    /// per type is inferred (there are no method bodies in the decompiled shell).
    /// </summary>
    private static string LearningText(Learning learning)
    {
        switch ((LearningType)learning.TypeId)
        {
            case LearningType.LevelUp:
                return $"Lv{learning.Value1} 学会";
            case LearningType.MagicStone:
                return "魔法石";
            case LearningType.Background:
                return "剧情";
            case LearningType.Equipment:
                return "装备";
            case LearningType.JobLevel:
                var job = JobName(learning.JobId);
                return string.IsNullOrEmpty(job)
                    ? $"职业 #{learning.JobId} Lv{learning.Value1}"
                    : $"{job} Lv{learning.Value1}";
            default:
                return $"学习表 #{learning.Id}";
        }
    }

    /// <summary>
    /// 0.14.4: the blue spell an enemy move teaches, via BlueMagicData.BlueMagicLearningAbilityIds
    /// (used ability id -> learnable ability ids). 0 when it does not teach one. The game's own
    /// resolver is a fallback when the serialized table has not been read.
    /// </summary>
    private static int BlueLearningAbility(int usedAbilityId)
    {
        if (usedAbilityId <= 0)
        {
            return 0;
        }
        try
        {
            var data = Serial.ProviderManager.instance?.BlueMagicProvider?.serialData?
                .TryCast<Serial.FF5.Management.BlueMagicData>();
            var map = data?.BlueMagicLearningAbilityIds;
            if (map != null && map.TryGetValue(usedAbilityId, out var list) &&
                list != null && list.Count > 0)
            {
                return list[0];
            }
        }
        catch (Exception)
        {
        }
        try
        {
            return Serial.ProviderManager.instance?.BlueMagicProvider?
                .GetLearningAbilityId(usedAbilityId) ?? 0;
        }
        catch (Exception)
        {
            return 0;
        }
    }
}
#endif
