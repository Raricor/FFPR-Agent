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

/// <summary>Screens with cursors: the shop, the field menu (magic, items, equipment) and the save list.</summary>
internal static partial class GameState
{
    private static Last.UI.KeyInput.ShopController _shop;
    private static Last.UI.KeyInput.ShopCommandMenuController _shopMenu;
    private static Last.UI.KeyInput.ShopTradeWindowController _shopTrade;

    /// <summary>
    /// The shop when it is open: the command menu (Buy / Sell / Equipment / Back) and its
    /// cursor, the products with prices and the list cursor, and the quantity window.
    /// </summary>
    public static JsonObject Shop()
    {
        var shop = Active(ref _shop);
        if (shop == null)
        {
            return new JsonObject { ["open"] = false };
        }
        // The list stays on screen while the command menu has the cursor; the state tells
        // which one the keys go to (SelectCommand, SelectProduct, ConfirmationBuyMagic, ...).
        var o = new JsonObject { ["open"] = true, ["state"] = shop.stateMachine?.Current.ToString() };
        var menu = Active(ref _shopMenu);
        if (menu != null)
        {
            var commands = new JsonArray();
            var list = menu.contentList;
            for (var i = 0; list != null && i < list.Count; i++)
            {
                commands.Add(list[i]?.CommandId.ToString());
            }
            o["commands"] = commands;
            o["commandCursor"] = menu.selectCursor?.Index;
        }
        var products = new JsonArray();
        var data = shop.productDataList;
        for (var i = 0; data != null && i < data.Count; i++)
        {
            var d = data[i];
            products.Add(new JsonObject
            {
                ["name"] = d?.ProductName,
                ["id"] = d?.ContentId,
                ["buy"] = d?.Buy,
                ["type"] = d?.ContentType.ToString(),
            });
        }
        o["products"] = products;
        var listMain = shop.listController?.listController;
        if (listMain != null && listMain.gameObject.activeInHierarchy)
        {
            o["listCursor"] = listMain.selectCursor?.Index;
            // 0.7.0: for the highlighted weapon or armour, each member as the shop shows it:
            // cannot equip it, would be stronger or weaker with it, or has it on already. Buying
            // four of everything wasted gil on gear nobody could wear (10-21).
            var rows = new JsonArray();
            var members = listMain.characterContentList;
            for (var i = 0; members != null && i < members.Count; i++)
            {
                var row = members[i];
                if (row == null || !row.gameObject.activeInHierarchy || row.Data == null)
                {
                    continue;
                }
                var view = row.view;
                rows.Add(new JsonObject
                {
                    ["name"] = row.Data.Name,
                    ["canEquip"] = !Shown(view?.stateImpossibleText),
                    ["up"] = Shown(view?.stateUpImage),
                    ["down"] = Shown(view?.stateDownImage),
                    ["equipped"] = Shown(view?.stateEquippedImage) || Shown(view?.stateEquippedText),
                });
            }
            o["party"] = rows;
            // 0.7.3: the list as drawn (when selling, the bag's items): name, price, how many
            // held, whether it can be picked, and which row has the cursor.
            var drawn = new JsonArray();
            var contents = listMain.productContentList;
            for (var i = 0; contents != null && i < contents.Count; i++)
            {
                var c = contents[i];
                if (c == null || !c.gameObject.activeInHierarchy)
                {
                    continue;
                }
                var v = c.shopListItemContentView;
                var name = c.iconTextView?.nameText?.text;
                if (string.IsNullOrEmpty(name))
                {
                    continue;
                }
                var focus = c.FocusCursorParent != null && c.FocusCursorParent.transform.childCount > 0;
                drawn.Add(new JsonObject
                {
                    ["name"] = name,
                    ["price"] = v?.priceText?.text,
                    ["have"] = v?.haveText?.text,
                    ["canSelect"] = c.CanSelect,
                    ["focus"] = focus,
                });
            }
            o["rows"] = drawn;
        }
        var trade = Active(ref _shopTrade);
        if (trade != null)
        {
            o["trade"] = new JsonObject
            {
                ["count"] = trade.selectedCount,
                ["max"] = trade.possibleCount,
                ["price"] = trade.price,
            };
        }
        return o;
    }

    private static bool Shown(UnityEngine.Component c) => c != null && c.gameObject.activeInHierarchy;

    private static Last.UI.KeyInput.MainMenuController _mainMenu;
#if FF5
    // FF5's own (Serial.FF5) and template (Serial.Template) windows; other games have their own.
    private static Serial.Template.UI.KeyInput.StatusWindowControllerBase _menuParty;
    private static Serial.FF5.UI.KeyInput.AbilityWindowController _magicMenu;
#endif
    private static Last.UI.KeyInput.ItemWindowController _itemMenu;
    private static Last.UI.KeyInput.EquipmentWindowController _equipMenu;
#if FF5
    private static Serial.FF5.UI.KeyInput.JobChangeWindowController _jobMenu;
#endif

    /// <summary>
    /// The field menu when it is open: its commands and cursor, the sub-menu showing, the
    /// party cursor, and for the magic, item and equipment windows their lists, cursors and
    /// target rows. Lets a menu skill (heal with magic, use a potion, equip) check each step
    /// against the screen instead of counting key presses.
    /// </summary>
    public static JsonObject Menu()
    {
        var main = Active(ref _mainMenu);
        if (main == null || !main.IsOpne)
        {
            return new JsonObject { ["open"] = false };
        }
        var o = new JsonObject { ["open"] = true, ["state"] = main.stateMachine?.Current.ToString() };
        var commandMenu = main.commandMenuController;
        if (commandMenu != null)
        {
            var commands = new JsonArray();
            var contents = commandMenu.contents;
            for (var i = 0; contents != null && i < contents.Count; i++)
            {
                var data = contents[i]?.Data;
                commands.Add(new JsonObject
                {
                    ["id"] = data?.Id.ToString(),
                    ["name"] = Label(data?.Name),
                    ["enabled"] = contents[i]?.IsEnable,
                });
            }
            o["commands"] = commands;
            o["cursor"] = commandMenu.selectCursor?.Index;
        }
#if FF5
        var party = Active(ref _menuParty);
        if (party != null)
        {
            o["partyCursor"] = party.selectCursor?.Index;
        }
        var magic = Active(ref _magicMenu);
        if (magic != null)
        {
            o["magic"] = MagicMenu(magic);
        }
#endif
        var item = Active(ref _itemMenu);
        if (item != null)
        {
            o["item"] = ItemMenu(item);
        }
        var equip = Active(ref _equipMenu);
        if (equip != null)
        {
            o["equipment"] = EquipmentMenu(equip);
        }
#if FF5
        var job = Active(ref _jobMenu);
        if (job != null)
        {
            o["job"] = JobMenu(job);
        }
#endif
        return o;
    }

#if FF5
    /// <summary>
    /// 0.7.5: the job change window. The grid cells are JobChangeWindowView.jobContentList,
    /// in screen order; each cell shows its name in JobContentView.jobNameText and whether it
    /// can be picked in JobContentController.IsEnable. The controller stores no job id per
    /// cell (SetData only passes it to the native side), so the id is matched by name from the
    /// job master (JobName); see JobIdByName in GameState.Party.cs.
    /// </summary>
    private static JsonObject JobMenu(Serial.FF5.UI.KeyInput.JobChangeWindowController job)
    {
        var target = job.targets != null && job.targetIndex >= 0 && job.targetIndex < job.targets.Count
            ? job.targets[job.targetIndex]
            : null;
        var o = new JsonObject
        {
            ["state"] = job.stateMachine?.Current.ToString(),
            ["character"] = target?.Name,
            ["targetCursor"] = job.targetIndex,
            ["jobCursor"] = job.jobSelectCursor?.Index,
            // RawIndex and ColmIndex are the grid cursor's row and column (the base controller
            // spells column "Colm"); maxColumnCount is how many cells a row holds.
            ["gridCursor"] = new JsonObject
            {
                ["row"] = job.RawIndex,
                ["col"] = job.ColmIndex,
            },
            ["maxColumnCount"] = job.maxColumnCount,
            ["maxRowCount"] = job.maxRowCount,
        };
        var targets = new JsonArray();
        for (var i = 0; job.targets != null && i < job.targets.Count; i++)
        {
            targets.Add(job.targets[i]?.Name);
        }
        o["targets"] = targets;

        var columns = job.maxColumnCount > 0 ? job.maxColumnCount : 1;
        var cells = new JsonArray();
        var contents = job.view?.jobContentList;
        for (var i = 0; contents != null && i < contents.Count; i++)
        {
            var content = contents[i];
            if (content == null)
            {
                continue;
            }
            var name = content.view?.jobNameText?.text;
            var cell = new JsonObject
            {
                ["index"] = i,
                ["row"] = i / columns,
                ["col"] = i % columns,
                ["name"] = name,
                ["enabled"] = content.IsEnable,
                ["active"] = content.gameObject.activeInHierarchy,
            };
            var id = JobIdByName(name);
            if (id != null)
            {
                cell["id"] = id.Value;
            }
            cells.Add(cell);
        }
        o["jobs"] = cells;

        var popup = job.popup;
        var popupNode = new JsonObject { ["open"] = Shown(popup) };
        if (Shown(popup))
        {
            popupNode["job"] = popup.JobName;
            popupNode["confirm"] = popup.ConfirmText;
            popupNode["cursor"] = popup.selectCursor?.Index;
            var commands = new JsonArray();
            var list = popup.commandList;
            for (var i = 0; list != null && i < list.Count; i++)
            {
                commands.Add(new JsonObject
                {
                    ["name"] = list[i]?.Text?.text,
                    ["enabled"] = list[i]?.IsEnable,
                });
            }
            popupNode["commands"] = commands;
        }
        o["popup"] = popupNode;
        return o;
    }
#endif

#if FF5
    private static JsonObject MagicMenu(Serial.FF5.UI.KeyInput.AbilityWindowController magic)
    {
        var o = new JsonObject
        {
            ["state"] = magic.stateMachine?.Current.ToString(),
            ["character"] = magic.statusController?.targetData?.Name,
        };
        var commands = magic.commandController;
        if (commands != null)
        {
            var names = new JsonArray();
            var list = commands.contentList;
            for (var i = 0; list != null && i < list.Count; i++)
            {
                var c = list[i];
                names.Add(new JsonObject
                {
                    ["name"] = Label(c?.Data?.Name) ?? Text(c?.Command?.MesIdName),
                    ["enabled"] = c?.IsEnable,
                });
            }
            o["commands"] = names;
            o["commandCursor"] = commands.selectCursor?.Index;
        }
        var abilities = magic.listController;
        if (abilities != null && abilities.gameObject.activeInHierarchy)
        {
            var entries = new JsonArray();
            var owned = abilities.AbilityList;
            var usable = abilities.canUseAbilityIds;
            for (var i = 0; owned != null && i < owned.Count; i++)
            {
                var a = owned[i];
                var id = a?.Ability?.Id;
                entries.Add(new JsonObject
                {
                    ["name"] = a == null ? null : Text(a.MesIdName),
                    ["id"] = id,
                    ["mp"] = a?.Ability?.UseValue,
                    ["usable"] = id != null && usable != null && usable.ContainsKey(id.Value) ? usable[id.Value] : null,
                });
            }
            o["abilities"] = entries;
            // The list scrolls: the selected index counts from the top of the list, the
            // cursor from the top of the visible rows.
            o["abilityIndex"] = abilities.SelectedIndex;
            o["abilityCursor"] = abilities.selectCursor?.Index;
            // 0.6.5: the list is a grid of every slot of the magic type, three a row, unlearned
            // ones blank, and the cursor moves over all of them (10-20: 解毒 sits at 2 behind an
            // unlearned 侦测, while `abilities` lists learned spells only). The slots' ability
            // ids in order, from both lists the controller keeps, and the highlighted one.
            o["slotIds"] = AbilityIds(abilities.abilityList);
            var drawn = new JsonArray();
            var contents = abilities.contentList;
            for (var i = 0; contents != null && i < contents.Count; i++)
            {
                drawn.Add(contents[i]?.Data?.Ability?.Id);
            }
            o["contentIds"] = drawn;
            o["selectedId"] = abilities.selectedAbility?.Ability?.Id;
        }
        var use = magic.useController;
        if (use != null && use.gameObject.activeInHierarchy)
        {
            o["targets"] = Targets(use.contentList);
            o["targetCursor"] = use.selectCursor?.Index;
            o["targetMode"] = use.stateMachine?.Current.ToString();
        }
        return o;
    }
#endif

    private static JsonObject ItemMenu(Last.UI.KeyInput.ItemWindowController item)
    {
        var o = new JsonObject
        {
            ["state"] = item.stateMachine?.Current.ToString(),
            ["commandCursor"] = item.commandController?.selectCursor?.Index,
            ["selected"] = item.selectedItem?.Name,
        };
        var list = item.itemListController;
        if (list != null && list.gameObject.activeInHierarchy)
        {
            // The game builds the rows lazily; when it kept them as a list, report them.
            var rows = list.dataList?.TryCast<Il2CppSystem.Collections.Generic.List<Last.UI.ItemListContentData>>();
            if (rows != null)
            {
                var names = new JsonArray();
                for (var i = 0; i < rows.Count; i++)
                {
                    names.Add(new JsonObject { ["name"] = rows[i]?.Name, ["count"] = rows[i]?.Count });
                }
                o["rows"] = names;
            }
            o["listCursor"] = list.selectCursor?.Index;
        }
        var use = item.itemUseController;
        if (use != null && use.gameObject.activeInHierarchy)
        {
            o["targets"] = Targets(use.contentList);
            o["targetCursor"] = use.selectCursor?.Index;
            o["targetMode"] = use.stateMachine?.Current.ToString();
        }
        return o;
    }

    private static JsonObject EquipmentMenu(Last.UI.KeyInput.EquipmentWindowController equip)
    {
        var o = new JsonObject
        {
            ["state"] = equip.stateMachine?.Current.ToString(),
            ["commandCursor"] = equip.commandController?.selectCursor?.Index,
            ["slot"] = equip.selectedSlot.ToString(),
        };
        var info = equip.infoWindowController;
        if (info != null && info.gameObject.activeInHierarchy)
        {
            var slots = new JsonArray();
            var list = info.contentList;
            for (var i = 0; list != null && i < list.Count; i++)
            {
                var row = list[i];
                slots.Add(new JsonObject
                {
                    ["slot"] = row?.Slot.ToString(),
                    ["item"] = row?.Data?.Name,
#if !(FF1 || FF2 || FF3)
                    // 10-28: FF1-FF3's equipment rows have no enabled flag.
                    ["enabled"] = row?.IsEnable,
#endif
                });
            }
            o["slots"] = slots;
            o["slotCursor"] = info.selectCursor?.Index;
        }
        var select = equip.selectWindowController;
        if (select != null && select.gameObject.activeInHierarchy)
        {
            var candidates = new JsonArray();
            var data = select.ContentDataList;
            for (var i = 0; data != null && i < data.Count; i++)
            {
                candidates.Add(new JsonObject { ["name"] = data[i]?.Name, ["count"] = data[i]?.Count });
            }
            o["candidates"] = candidates;
            o["candidateCursor"] = select.selectCursor?.Index;
        }
        return o;
    }

    private static JsonArray AbilityIds(Il2CppSystem.Collections.Generic.List<Last.Data.User.OwnedAbility> list)
    {
        var ids = new JsonArray();
        for (var i = 0; list != null && i < list.Count; i++)
        {
            ids.Add(list[i]?.Ability?.Id);
        }
        return ids;
    }

    /// <summary>The character rows of a use-on-whom list, with HP and MP.</summary>
    private static JsonArray Targets(Il2CppSystem.Collections.Generic.List<Last.UI.KeyInput.ItemTargetSelectContentController> list)
    {
        var rows = new JsonArray();
        for (var i = 0; list != null && i < list.Count; i++)
        {
            var c = list[i]?.CurrentData;
            var p = c?.Parameter;
            rows.Add(new JsonObject
            {
                ["name"] = c?.Name,
                ["hp"] = p?.CurrentHP,
                ["maxHp"] = p?.ConfirmedMaxHp(),
                ["mp"] = p?.CurrentMP,
            });
        }
        return rows;
    }

    /// <summary>Menu labels are sometimes message keys and sometimes already text.</summary>
    private static string Label(string name) =>
        name != null && name.StartsWith("MSG_", StringComparison.Ordinal) ? Text(name) ?? name : name;

    private static Last.UI.KeyInput.SaveListController _saveList;

    /// <summary>The save/load slot list when it is open: the highlighted slot and all slot ids.</summary>
    public static JsonObject SaveUi()
    {
        if (_saveList == null)
        {
            _saveList = UnityEngine.Object.FindObjectOfType(Il2CppType.Of<Last.UI.KeyInput.SaveListController>())
                ?.TryCast<Last.UI.KeyInput.SaveListController>();
        }
        var list = _saveList;
        if (list == null || !list.gameObject.activeInHierarchy)
        {
            return new JsonObject { ["open"] = false };
        }
        var slots = new JsonArray();
        var data = list.DataList;
        for (var i = 0; data != null && i < data.Count; i++)
        {
            slots.Add(data[i]?.Id);
        }
        return new JsonObject
        {
            ["open"] = true,
            ["current"] = list.CurrentSlotData?.Id,
            ["cursor"] = list.selectCursor?.Index,
            ["slots"] = slots,
        };
    }

    private static Last.UI.KeyInput.TitleMenuCommandController _title;

    /// <summary>The title menu (New Game, Continue, ...): commands as shown, the cursor.</summary>
    /// <remarks>10-28: the other five games had no way to tell, minimized, whether Continue is
    /// there to pick; `defaultColor` false is how the game greys a command out.</remarks>
    public static JsonObject Title()
    {
        var title = Active(ref _title);
        if (title == null)
        {
            return new JsonObject { ["open"] = false };
        }
        var commands = new JsonArray();
        var list = title.activeContents;
        for (var i = 0; list != null && i < list.Count; i++)
        {
            var c = list[i];
            commands.Add(new JsonObject
            {
                ["id"] = c?.CommandId.ToString(),
                ["name"] = c?.nameText?.text,
                ["defaultColor"] = c?.IsDefaultColor,
            });
        }
        return new JsonObject
        {
            ["open"] = true,
            ["commands"] = commands,
            ["cursor"] = title.selectCursor?.Index,
        };
    }

    /// <summary>The text fields on screen (naming boxes): their text, and which one is typed in.</summary>
    public static JsonObject TextInput()
    {
        var fields = new JsonArray();
        foreach (var found in UnityEngine.Object.FindObjectsOfType(Il2CppType.Of<UnityEngine.UI.InputField>()))
        {
            var field = found.TryCast<UnityEngine.UI.InputField>();
            if (field == null || !field.gameObject.activeInHierarchy)
            {
                continue;
            }
            fields.Add(new JsonObject
            {
                ["name"] = field.gameObject.name,
                ["text"] = field.text,
                ["focused"] = field.isFocused,
            });
        }
        return new JsonObject { ["open"] = fields.Count > 0, ["fields"] = fields };
    }
}
