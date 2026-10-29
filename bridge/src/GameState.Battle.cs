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

/// <summary>Battles: both sides' units and the command menu.</summary>
internal static partial class GameState
{
    private static JsonNode Battle()
    {
        var b = BattlePlugManager.instance;
        if (b == null)
        {
            return null;
        }
        var o = new JsonObject { ["active"] = b.isBattle };
#if !(FF2 || FF3 || FF4)
        // 10-28: FF2-FF4 have no AR battles.
        o["ar"] = b.isArBattle;
#endif
        if (b.isBattle)
        {
            var info = b.BattleStatusControl?.BattleStatusControlInfo;
            o["enemies"] = Units(info?.battleEnemyDatas, enemy: true);
            o["players"] = Units(info?.battlePlayerDatas, enemy: false);
            var party = b.MonsterParty;
            if (party != null)
            {
                o["party"] = party.Id;
                o["notEscape"] = party.NotEscape;
            }
            var boss = false;
            foreach (var e in o["enemies"]?.AsArray() ?? new JsonArray())
            {
                boss |= (e?["boss"]?.GetValue<int>() ?? 0) != 0;
            }
            o["boss"] = boss;
        }
        return o;
    }

    /// <summary>Name and HP of each battle unit; enemy names resolved from the monster master.</summary>
    private static JsonArray Units<T>(Il2CppSystem.Collections.Generic.List<T> list, bool enemy)
        where T : Last.Battle.BattleUnitData
    {
        if (list == null)
        {
            return null;
        }
        var units = new JsonArray();
        for (var i = 0; i < list.Count; i++)
        {
            var unit = list[i];
            if (unit == null)
            {
                continue;
            }
            var p = unit.BattleUnitDataInfo?.Parameter;
            var o = new JsonObject
            {
                ["hp"] = p?.CurrentHP,
                ["maxHp"] = p?.ConfirmedMaxHp(),
                ["mp"] = p?.CurrentMP,
            };
            // 0.6.3: status conditions (麻痹, 石化, 毒 ...); Karlabos's paralysis kept Faris out
            // of a whole fight unseen (10-20).
            var status = Conditions(p?.CurrentConditionList);
            if (status != null)
            {
                o["status"] = status;
            }
            if (enemy)
            {
                var monster = unit.TryCast<Last.Battle.BattleEnemyData>()?.MonsterMaster;
                o["name"] = monster == null ? null : Text(monster.MesIdName);
                o["id"] = monster?.Id;
                // 0.6.9: the bestiary number, which the guides use (030 Jackanapes, 10-21).
                o["book"] = monster == null ? null : BookNumber(monster.Id);
                o["lv"] = monster?.Lv;
                o["boss"] = monster?.Boss;
            }
            else
            {
                o["name"] = unit.TryCast<global::BattlePlayerData>()?.ownedCharacterData?.Name;
            }
            units.Add(o);
        }
        return units;
    }

    private static Dictionary<int, int> _books;
    private static Dictionary<int, (int Group, int Type)> _groups;

    /// <summary>The bestiary's groups (PictureBookGroup): an entry's number as the bestiary
    /// shows it. Forms and variants of one monster are separate entries in one group (10-21:
    /// the entry ids ran four ahead of the numbers shown by Walse).</summary>
    private static Dictionary<int, (int Group, int Type)> Groups()
    {
        if (_groups != null)
        {
            return _groups;
        }
        var groups = new Dictionary<int, (int, int)>();
        var master = Il2CppSystem.SingletonMonoBehaviour<Last.Data.Master.MasterManager>.instance;
        for (var id = 1; master != null && id <= 1024; id++)
        {
            try
            {
                var g = master.GetData<Last.Data.Master.PictureBookGroup>(id);
                if (g != null && !groups.ContainsKey(g.PictureBookId))
                {
                    groups[g.PictureBookId] = (g.Group, g.GroupType);
                }
            }
            catch (Exception)
            {
                // ids with no entry
            }
        }
        if (groups.Count > 0)
        {
            _groups = groups;
        }
        return groups;
    }

    /// <summary>The bestiary (PictureBook) number of a monster id, from the master data; null
    /// for monsters the bestiary does not list.</summary>
    private static int? BookNumber(int monsterId)
    {
        if (_books == null)
        {
            var books = new Dictionary<int, int>();
            var master = Il2CppSystem.SingletonMonoBehaviour<Last.Data.Master.MasterManager>.instance;
            for (var id = 1; master != null && id <= 512; id++)
            {
                try
                {
                    var book = master.GetData<Last.Data.Master.PictureBook>(id);
                    if (book != null && !books.ContainsKey(book.MonsterId))
                    {
                        books[book.MonsterId] = book.Id;
                    }
                }
                catch (Exception)
                {
                    // ids with no entry
                }
            }
            if (books.Count == 0)
            {
                return null;  // the master data is not loaded yet: try again next time
            }
            _books = books;
        }
        if (!_books.TryGetValue(monsterId, out var entry))
        {
            return null;
        }
        return Groups().TryGetValue(entry, out var group) ? group.Group : entry;
    }

    /// <summary>The bestiary master as stored: each entry's id, monster, monster name, and the
    /// fields that might order the numbers shown (0.7.1, to pin the numbering down).</summary>
    public static JsonArray Bestiary()
    {
        var rows = new JsonArray();
        var master = Il2CppSystem.SingletonMonoBehaviour<Last.Data.Master.MasterManager>.instance;
        for (var id = 1; master != null && id <= 512; id++)
        {
            Last.Data.Master.PictureBook book;
            try
            {
                book = master.GetData<Last.Data.Master.PictureBook>(id);
            }
            catch (Exception)
            {
                continue;
            }
            if (book == null)
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
            rows.Add(new JsonObject
            {
                ["id"] = book.Id,
                ["monster"] = book.MonsterId,
                ["name"] = monster == null ? null : Text(monster.MesIdName),
                ["scenario"] = book.ScenarioNumber,
                ["display"] = book.StatusDisplay,
                ["habitat"] = book.HabitatPointGroupId,
                ["group"] = Groups().TryGetValue(book.Id, out var g) ? g.Group : null,
                ["groupType"] = Groups().TryGetValue(book.Id, out var gt) ? gt.Type : null,
            });
        }
        return rows;
    }

    private static Last.UI.KeyInput.BattleCommandSelectController _commandMenu;
#if FF5
    private static Serial.FF5.UI.KeyInput.BattleQuantityAbilityInfomationController _abilityMenu;
#endif
    private static Last.UI.KeyInput.BattleMenuController _battleMenu;
    private static Il2CppInterop.Runtime.InteropTypes.Arrays.Il2CppReferenceArray<UnityEngine.Object> _targetMenus;
    private static float _nextTargetSearch;

    /// <summary>
    /// The battle target cursor while it is up. Its GameObject (target_select_info_window) stays
    /// inactive even then — 10-27 probe: activeSelf false, state Enemys, cursor shown — so the
    /// activeInHierarchy test never saw it and `target` always read null. The open instance is
    /// the one whose state machine is in a target state.
    /// </summary>
    private static Last.UI.KeyInput.BattleTargetSelectController TargetMenu()
    {
        for (var pass = 0; pass < 2; pass++)
        {
            for (var i = 0; _targetMenus != null && i < _targetMenus.Length; i++)
            {
                try
                {
                    var menu = _targetMenus[i]?.TryCast<Last.UI.KeyInput.BattleTargetSelectController>();
                    var state = menu?.stateMachine?.Current.ToString();
                    if (state != null && state != "None")
                    {
                        return menu;
                    }
                }
                catch (Exception)
                {
                    _targetMenus = null; // destroyed with the last battle scene
                    break;
                }
            }
            // Instances come and go with battle scenes; look again at most once a second.
            if (pass > 0 || Time.unscaledTime < _nextTargetSearch)
            {
                break;
            }
            _nextTargetSearch = Time.unscaledTime + 1f;
            _targetMenus = UnityEngine.Resources.FindObjectsOfTypeAll(
                Il2CppType.Of<Last.UI.KeyInput.BattleTargetSelectController>());
        }
        return null;
    }
    private static Last.UI.KeyInput.BattleItemInfomationController _battleItems;

    /// <summary>
    /// The battle command menu: whose turn it is, the commands with the highlighted one, and,
    /// when a magic or ability list is open, its entries and cursor. Lets a battle skill pick
    /// a command by name instead of by blind key presses.
    /// </summary>
    public static JsonObject BattleMenu()
    {
        var o = new JsonObject { ["battle"] = BattlePlugManager.instance?.isBattle ?? false };
        // 0.6.0: windows stay on screen after they lose the keys, so the states say which one
        // takes them: the battle menu (Waiting / CommandSelecting), the command list (None
        // once a command is chosen) and the target cursor (Players / Enemys / ...).
        o["menuState"] = Active(ref _battleMenu)?.stateMachine?.Current.ToString();
        var units = Battle() as JsonObject;
        if (units != null && (units["active"]?.GetValue<bool>() ?? false))
        {
            foreach (var side in new[] { "players", "enemies" })
            {
                var list = units[side];
                units.Remove(side);
                o[side] = list;
            }
        }
        var target = TargetMenu();
        if (target != null)
        {
            o["target"] = new JsonObject
            {
                ["state"] = target.stateMachine?.Current.ToString(),
                ["cursor"] = target.selectCursor?.Index,
            };
        }
        // 0.6.2: the item list (Phoenix Downs, potions): what is held, in list order, and the
        // cursor; UseSelect while it has the keys.
        var items = Active(ref _battleItems);
        if (items != null)
        {
            o["itemState"] = items.stateMachine?.Current.ToString();
            var held = new JsonArray();
            var data = items.dataList;
            for (var i = 0; data != null && i < data.Count; i++)
            {
                var item = data[i];
                held.Add(new JsonObject
                {
                    ["id"] = item?.ContentId,
                    ["name"] = item?.Name,
                    ["count"] = item?.Count,
                });
            }
            o["items"] = held;
            o["itemCursor"] = items.selectCursor?.Index;
        }
        var menu = Active(ref _commandMenu);
        if (menu != null)
        {
            o["commandState"] = menu.stateMachine?.Current.ToString();
            var commands = new JsonArray();
            var list = menu.contentList;
            for (var i = 0; list != null && i < list.Count; i++)
            {
                var command = list[i]?.TargetCommand;
                commands.Add(new JsonObject
                {
                    ["name"] = command == null ? null : Text(command.MesIdName),
                    ["id"] = command?.Id,
                    ["enabled"] = list[i]?.IsEnable,
                });
            }
            o["actor"] = menu.targetData?.Name;
            o["commands"] = commands;
            o["cursor"] = menu.selectCursor?.Index;
        }
#if FF5
        var abilities = Active(ref _abilityMenu);
        if (abilities != null)
        {
            var entries = new JsonArray();
            var data = abilities.dataList;
            for (var i = 0; data != null && i < data.Count; i++)
            {
                var a = data[i];
                entries.Add(new JsonObject
                {
                    ["name"] = a == null ? null : Text(a.MesIdName),
                    ["id"] = a?.Ability?.Id,
                    ["mp"] = a?.Ability?.UseValue,
                });
            }
            o["abilities"] = entries;
            // The list keeps one cursor per selection (for multi-target abilities).
            var cursors = abilities.selectCursorList;
            var which = abilities.selectCursorIndex;
            o["abilityCursor"] = cursors != null && which >= 0 && which < cursors.Count ? cursors[which]?.Index : null;
            // 0.6.0: dataList holds every slot of the magic type, learned or not, and its names
            // read empty in battle (10-20). What the player sees is the content list: the names
            // as drawn and the highlighted one. AbilitySelect while the list has the keys.
            o["abilityState"] = abilities.stateMachine?.Current.ToString();
            var shown = new JsonArray();
            var contents = abilities.contentList;
            for (var i = 0; contents != null && i < contents.Count; i++)
            {
                var c = contents[i];
                var name = c != null && c.gameObject.activeInHierarchy ? c.iconTextView?.nameText?.text : null;
                if (string.IsNullOrEmpty(name))
                {
                    continue;
                }
                var focus = c.iconTextView?.isFocus ?? false;
                shown.Add(new JsonObject
                {
                    ["name"] = name,
                    ["id"] = c.Data?.Ability?.Id,
                    ["mp"] = c.Data?.Ability?.UseValue,
                    ["focus"] = focus,
                });
                if (focus)
                {
                    o["ability"] = name;
                }
            }
            o["shown"] = shown;
        }
#endif
        return o;
    }
}
