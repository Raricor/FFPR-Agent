using System;
using System.Text.Json.Nodes;
using Last.Battle;
using Last.Management;

namespace FfprBridge;

/// <summary>
/// 0.14.2: the game's saved settings, read-only. ConfigSaveData is the object the game itself
/// keeps in UserDataManager; the auto-battle switch is the one on the running battle, not the
/// "keep auto battle" setting.
/// </summary>
internal static partial class GameState
{
    /// <summary>
    /// The settings the config screen writes. Names follow ConfigSaveData; values are the raw
    /// indices except battleMode, which the game's own resolver maps to wait/active.
    /// Throws when the game has not loaded the settings yet, so the query replies with
    /// {"config": null, "error": "..."}.
    /// </summary>
    public static JsonNode Config()
    {
        var settings = UserDataManager.instance?.configSaveData;
        if (settings == null)
        {
            throw new InvalidOperationException("游戏还没读出 ConfigSaveData");
        }
        var o = new JsonObject
        {
            ["isKeepAutoBattle"] = settings.IsKeepAutoBattle,
            ["battleModeIndex"] = settings.BattleModeIndex,
            ["battleSpeedIndex"] = settings.BattleSpeedIndex,
            ["battleMessageSpeedIndex"] = settings.BattleMessageSpeedIndex,
            ["messageSpeed"] = settings.MessageSpeed,
            ["isAutoDash"] = settings.IsAutoDash,
            ["reequipIndex"] = settings.ReequipIndex,
            ["isCursorMemory"] = settings.IsCursorMemory,
        };
        // 0.14.2: BattleUtility is the game's own mapping; do not guess what an index means.
        try
        {
            var mode = BattleUtility.GetBattleModeByConfigValue(settings.BattleModeIndex);
            o["battleMode"] = mode.ToString().ToLowerInvariant();
        }
        catch (Exception)
        {
            // No label; the raw index above is still there.
        }
        try
        {
            var button = settings.BattleModeButton;
            o["battleModeButton"] = (int)button;
            o["battleModeButtonName"] = button.ToString().ToLowerInvariant();
        }
        catch (Exception)
        {
            // No label; the rest of the settings are still readable.
        }
        // The saved isKeepAutoBattle only says "carry it across battles"; this is the switch the
        // current battle runs with. Outside battle there is no such switch, so null.
        o["battleAuto"] = null;
        try
        {
            var battle = BattlePlugManager.instance;
            if (battle != null && battle.isBattle)
            {
                o["battleAuto"] = battle.BattleStatusControl?.isAutoMode;
            }
        }
        catch (Exception)
        {
            // The battle is changing scenes; the saved settings above are still good.
        }
        return o;
    }
}
