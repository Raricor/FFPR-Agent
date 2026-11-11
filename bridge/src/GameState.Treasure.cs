using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using Last.Management;

namespace FfprBridge;

/// <summary>
/// 0.14.8: every treasure flag in one read. The old `entities` answer only covered chests on
/// the map that was loaded, so a restarted client forgot that Tule's eleven chests were open
/// and kept planning that section again. <c>MapUIManager.GetTreasureFlag</c> reads any flag
/// without loading its map; this query walks the master data's TreasureBox rows once and
/// reports each flag, which is the same test the game uses. Read only.
/// </summary>
internal static partial class GameState
{
    /// <summary>
    /// <c>{"flags": {"12": true, "13": false, "14": null}, "total": 3}</c>; a flag whose read
    /// throws is null. At the title screen or while a save is loading, the master data or the
    /// owned party is not ready yet, so the answer is <c>{"ready": false}</c> and the caller
    /// keeps its old state.
    /// </summary>
    public static JsonObject TreasureFlags()
    {
        var master = Il2CppSystem.SingletonMonoBehaviour<Last.Data.Master.MasterManager>.instance;
        var boxes = master?.GetList<Last.Data.Master.TreasureBox>();
        var user = UserDataManager.instance;
        var owned = user?.OwnedCharacterList;
        if (boxes == null || boxes.Count == 0 || owned == null || owned.Count == 0)
        {
            return new JsonObject { ["ready"] = false };
        }
        // Sorted so two reads of the same save produce the same object, which makes a diff easy.
        var flags = new SortedDictionary<int, bool?>();
        foreach (var pair in boxes)
        {
            var box = pair.Value;
            if (box == null)
            {
                continue;
            }
            var flag = box.Flag;
            if (flags.ContainsKey(flag))
            {
                continue;
            }
            bool? open;
            try
            {
                open = Last.Map.MapUIManager.GetTreasureFlag(flag);
            }
            catch (Exception)
            {
                // One unreadable flag must not hide the other 224.
                open = null;
            }
            flags.Add(flag, open);
        }
        var rows = new JsonObject();
        foreach (var pair in flags)
        {
            rows[pair.Key.ToString()] = pair.Value == null ? null : pair.Value.Value;
        }
        return new JsonObject { ["flags"] = rows, ["total"] = flags.Count };
    }
}
