#if FF5
using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using Last.Data.User;
using Last.Management;
using MasterManager = Last.Data.Master.MasterManager;

namespace FfprBridge;

/// <summary>
/// 0.14.9: where every owned vehicle is parked. In FF5 the save keeps one
/// <c>OwnedTransportationData</c> per vehicle in <c>UserDataManager.OwnedTransportationList</c>
/// (backing field <c>&lt;OwnedTransportationList&gt;k__BackingField</c>). Its
/// <c>saveData</c> is a <c>SaveTransportationData</c>, which derives from
/// <c>Last.Map.SaveEntityData</c>; the cell is therefore
/// <c>saveData.position</c> (a Vector3 in cell coordinates) and <c>saveData.direction</c>,
/// while the map is <c>saveData.mapId</c> and the usable flag is <c>saveData.enable</c>.
/// The vehicle's kind comes from <c>Last.Data.Master.Transportation.TypeId</c> in the master
/// list, mapped through the game's own <c>MapConstants.TransportationType</c>.
/// Read only: nothing here moves a vehicle or changes the save.
/// </summary>
internal static partial class GameState
{
    /// <summary>
    /// <c>{"ready": true, "list": [{"id": 4, "type": 2, "typeName": "Ship", "map": 1,
    /// "cell": [150, 89], "layer": 0, "direction": 2, "enabled": true, "riding": false}]}</c>.
    /// A field that cannot be read is null. At the title screen or while a save is loading
    /// the owned list is not ready, so the answer is <c>{"ready": false}</c>.
    /// </summary>
    public static JsonObject Vehicles()
    {
        var user = UserDataManager.instance;
        var owned = user?.OwnedTransportationList;
        if (user == null || owned == null)
        {
            return new JsonObject { ["ready"] = false };
        }
        // An empty list is normal before the first vehicle; only call it "not ready" when the
        // game is not on a field either (title screen, loading, the very first frames).
        if (owned.Count == 0 && !TryPlayer(out _, out _))
        {
            return new JsonObject { ["ready"] = false };
        }

        var types = TransportationTypes();
        var ridingId = CurrentTransportationId();
        var list = new JsonArray();
        foreach (var data in owned)
        {
            if (data == null)
            {
                continue;
            }
            var save = data.saveData;
            int? id = null;
            int? type = null;
            string typeName = null;
            int? map = null;
            int[] cell = null;
            int? layer = null;
            int? direction = null;
            bool? enabled = null;
            bool? riding = null;
            try
            {
                id = data.Id;
            }
            catch (Exception)
            {
                // A field of one vehicle must not hide the others.
            }
            if (save != null)
            {
                try
                {
                    map = save.mapId;
                }
                catch (Exception)
                {
                }
                try
                {
                    enabled = save.enable;
                }
                catch (Exception)
                {
                }
                try
                {
                    var p = save.position;
                    cell = new[] { (int)Math.Round(p.x), (int)Math.Round(p.y) };
                    layer = (int)Math.Round(p.z);
                }
                catch (Exception)
                {
                }
                try
                {
                    direction = save.direction;
                }
                catch (Exception)
                {
                }
            }
            if (id != null && types.TryGetValue(id.Value, out var typeId))
            {
                type = typeId;
                typeName = TypeName(typeId);
            }
            try
            {
                riding = ridingId > 0 && id == ridingId;
            }
            catch (Exception)
            {
            }
            list.Add(new JsonObject
            {
                ["id"] = id == null ? null : id.Value,
                ["type"] = type == null ? null : type.Value,
                ["typeName"] = typeName,
                ["map"] = map == null ? null : map.Value,
                ["cell"] = cell == null ? null : new JsonArray(cell[0], cell[1]),
                ["layer"] = layer == null ? null : layer.Value,
                ["direction"] = direction == null ? null : direction.Value,
                ["enabled"] = enabled == null ? null : enabled.Value,
                ["riding"] = riding == null ? null : riding.Value,
            });
        }
        return new JsonObject { ["ready"] = true, ["list"] = list };
    }

    /// <summary>Vehicle id → master TypeId, copied once per query from the master list.</summary>
    private static Dictionary<int, int> TransportationTypes()
    {
        var types = new Dictionary<int, int>();
        try
        {
            var master = Il2CppSystem.SingletonMonoBehaviour<MasterManager>.instance;
            var rows = master?.GetList<Last.Data.Master.Transportation>();
            if (rows == null)
            {
                return types;
            }
            foreach (var pair in rows)
            {
                var row = pair.Value;
                if (row != null)
                {
                    types[row.Id] = row.TypeId;
                }
            }
        }
        catch (Exception)
        {
            // No master data yet; type and typeName stay null.
        }
        return types;
    }

    /// <summary>The id the game itself says the party is riding, or 0 on foot.</summary>
    private static int CurrentTransportationId()
    {
        try
        {
            if (TryPlayer(out var controller, out _))
            {
                var current = controller?.transportation?.CurrentTransportation;
                if (current != null && current.Id > 0)
                {
                    return current.Id;
                }
            }
        }
        catch (Exception)
        {
            // Fall through to the saved id.
        }
        try
        {
            return Last.Map.SaveMapManager.Instance?.SaveData?.TransportationId ?? 0;
        }
        catch (Exception)
        {
            return 0;
        }
    }

    private static string TypeName(int type)
    {
        try
        {
            return Enum.IsDefined(typeof(MapConstants.TransportationType), type)
                ? ((MapConstants.TransportationType)type).ToString()
                : null;
        }
        catch (Exception)
        {
            return null;
        }
    }
}
#endif
