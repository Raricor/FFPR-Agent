#if FF5
using System;
using System.Text.Json.Nodes;
using Il2CppInterop.Runtime;
using Last.Data.Master;
using Last.Management;
using UnityEngine;
using MasterMap = Last.Data.Master.Map;
using MapManager = Last.Map.MapManager;

namespace FfprBridge;

/// <summary>
/// One read-only map load in progress. Requests starts it on the game thread and calls Poll
/// once a frame; Result builds the reply when Poll is done or the caller's timeout expires.
/// A job never calls MapManager.RequestLoadMap or anything that creates a MapModel/entity.
/// </summary>
internal abstract class MapJob
{
    public int TimeoutMs = 5000;

    /// <summary>Advance the loader. True when there is nothing left to wait for.</summary>
    public abstract bool Poll();

    /// <summary>The reply body. timedOut means Poll was still false at the deadline.</summary>
    public abstract JsonObject Result(bool timedOut);

    /// <summary>Release a loader this job owns. Never throws into the game thread.</summary>
    public virtual void Close()
    {
    }
}

internal static partial class GameState
{
    private const int MapInfoMaxPackages = 200;
    private const int MapInfoMaxMaps = 200;
    private const int MapInfoMaxModels = 200;
    private const int MapAssetDefaultLimit = 20000;
    private const int MapAssetMaxLimit = 60000;
    private const int MapAssetDefaultTimeoutMs = 5000;

    /// <summary>
    /// 0.14.6, experimental: what the map system knows right now. No loader is started and no
    /// map is switched; this only reads the Map master row and the MapManager's own caches.
    /// </summary>
    public static JsonObject MapInfo()
    {
        var o = new JsonObject
        {
            ["assetPackageName"] = ReadString(() => MapManager.AssetPackageName),
            ["residentScriptGroupName"] = ReadString(() => MapManager.ResidentScriptGroupName),
            ["residentScriptCategoryName"] = ReadString(() => MapManager.ResidentScriptCategoryName),
            ["masterState"] = ReadString(() => Master()?.state.ToString()),
        };
        var mapId = CurrentMapId();
        if (mapId == null)
        {
            o["currentMapId"] = null;
        }
        else
        {
            o["currentMapId"] = mapId.Value;
        }
        if (mapId != null)
        {
            var row = MasterData<MasterMap>(mapId.Value);
            o["map"] = row == null ? null : MapRowNode(row);
            if (row == null)
            {
                o["mapError"] = $"Map 主数据里没有 {mapId.Value}";
            }
        }
        o["loaded"] = LoadedNode(CurrentMapManager());
        return o;
    }

    /// <summary>
    /// Start mappackage/mapasset. Only arguments are read here; the package loader itself is
    /// created and advanced by the job on later frames.
    /// </summary>
    public static MapJob StartMapJob(string op, JsonObject query)
    {
        var mapId = QueryInt(query["map"], 0, 0, int.MaxValue);
        if (mapId <= 0)
        {
            throw new ArgumentException($"{op} 需要 map(地图号)");
        }
        var row = MasterData<MasterMap>(mapId);
        if (row == null)
        {
            throw new ArgumentException($"Map 主数据里没有地图号 {mapId}");
        }
        MapJob job;
        if (op == "mappackage")
        {
            job = new MapPackageJob(row);
        }
        else
        {
            var asset = QueryString(query["asset"]);
            if (string.IsNullOrEmpty(asset))
            {
                throw new ArgumentException("mapasset 需要 asset(资源名，如 collision / entity_default)");
            }
            var offset = QueryInt(query["offset"], 0, 0, int.MaxValue);
            var limit = QueryInt(query["limit"], MapAssetDefaultLimit, 1, MapAssetMaxLimit);
            job = new MapAssetJob(row, asset.Trim(), offset, limit);
        }
        job.TimeoutMs = QueryInt(query["timeoutMs"], MapAssetDefaultTimeoutMs, 100, 30000);
        return job;
    }

    private static JsonObject MapRowNode(MasterMap map)
    {
        return new JsonObject
        {
            ["id"] = map.Id,
            ["mapName"] = map.MapName,
            ["mapNameText"] = Localized(map.MapName),
            ["assetName"] = map.AssetName,
            ["mapTitle"] = Localized(map.MapTitle),
            ["scriptId"] = map.ScriptId,
            ["bgmId"] = map.BgmId,
            ["loopType"] = map.LoopType,
            ["areaId"] = map.AreaId,
            ["floor"] = map.Floor,
            ["saveAvailability"] = map.SaveAvailability,
            ["movingAvailability"] = map.MovingAvailability,
        };
    }

    private static JsonObject LoadedNode(MapManager manager)
    {
        var o = new JsonObject();
        if (manager == null)
        {
            o["error"] = "当前没有可读的 MapManager(不在有地图管理器的场景)";
            return o;
        }
        o["packageList"] = PackageList(manager.packageList);
        o["packageLoadComplete"] = Keys(manager.packageLoadCompleteList);
        o["mapLoad"] = Keys(manager.mapLoadList);
        o["mapLoadComplete"] = Keys(manager.mapLoadCompleteList);
        o["mapModels"] = ModelList(manager.mapModelList);
        o["currentModel"] = ModelNode("current", manager.currentMapModel);
        return o;
    }

    private static JsonArray PackageList(Il2CppSystem.Collections.Generic.Dictionary<string, MapPackageData> list)
    {
        var rows = new JsonArray();
        if (list == null)
        {
            return rows;
        }
        foreach (var pair in list)
        {
            if (rows.Count >= MapInfoMaxPackages)
            {
                break;
            }
            var node = new JsonObject { ["key"] = pair.Key };
            var data = pair.Value;
            if (data != null)
            {
                node["assetGroupName"] = ReadString(() => data.AssetGroupName);
                node["assetPackageName"] = ReadString(() => data.AssetPackageName);
                AssetMapPackage package = null;
                try
                {
                    package = data.Package;
                }
                catch (Exception)
                {
                }
                if (package != null)
                {
                    node["name"] = package.name;
                    node["packageGroupName"] = package.asset_group_name;
                    node["mapCount"] = package.map == null ? 0 : package.map.Length;
                    node["maps"] = MapNames(package);
                }
                else
                {
                    node["loading"] = true;
                }
            }
            rows.Add(node);
        }
        return rows;
    }

    private static JsonArray MapNames(AssetMapPackage package)
    {
        var names = new JsonArray();
        for (var i = 0; package.map != null && i < package.map.Length && names.Count < MapInfoMaxMaps; i++)
        {
            names.Add(package.map[i] == null ? null : package.map[i].name);
        }
        return names;
    }

    private static JsonArray Keys<T>(Il2CppSystem.Collections.Generic.Dictionary<string, T> list)
    {
        var keys = new JsonArray();
        if (list == null)
        {
            return keys;
        }
        foreach (var pair in list)
        {
            if (keys.Count >= MapInfoMaxMaps)
            {
                break;
            }
            keys.Add(pair.Key);
        }
        return keys;
    }

    private static JsonArray ModelList(Il2CppSystem.Collections.Generic.Dictionary<string, Last.Map.MapModel> list)
    {
        var rows = new JsonArray();
        if (list == null)
        {
            return rows;
        }
        foreach (var pair in list)
        {
            if (rows.Count >= MapInfoMaxModels)
            {
                break;
            }
            rows.Add(ModelNode(pair.Key, pair.Value));
        }
        return rows;
    }

    private static JsonObject ModelNode(string key, Last.Map.MapModel model)
    {
        var o = new JsonObject { ["key"] = key };
        if (model == null)
        {
            return o;
        }
        try
        {
            o["id"] = model.GetId();
            o["areaId"] = model.GetAreaId();
            o["mapName"] = ReadString(() => model.GetMapName());
            var data = model.AssetData;
            if (data != null)
            {
                o["assetMapName"] = data.MapName;
            }
        }
        catch (Exception e)
        {
            o["error"] = $"{e.GetType().Name}: {e.Message}";
        }
        return o;
    }

    private static int? CurrentMapId()
    {
        try
        {
            return UserDataManager.instance?.CurrentMapId;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static MapManager CurrentMapManager()
    {
        try
        {
            // Do not require a player: the package/model caches are useful while a map is
            // loading and the player does not exist yet. FieldMap is the scene's map object.
            if (_fieldMap == null)
            {
                _fieldMap = UnityEngine.Object.FindObjectOfType(Il2CppType.Of<FieldMap>())?.TryCast<FieldMap>();
            }
            return _fieldMap?.fieldController?.mapManager;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static int QueryInt(JsonNode node, int fallback, int min, int max)
    {
        if (node != null)
        {
            try
            {
                return Math.Clamp(node.GetValue<int>(), min, max);
            }
            catch (Exception)
            {
            }
            try
            {
                if (int.TryParse(node.GetValue<string>(), out var text))
                {
                    return Math.Clamp(text, min, max);
                }
            }
            catch (Exception)
            {
            }
        }
        return Math.Clamp(fallback, min, max);
    }

    private static string QueryString(JsonNode node)
    {
        try
        {
            return node?.GetValue<string>();
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static bool Same(string left, string right)
    {
        return !string.IsNullOrEmpty(left) && !string.IsNullOrEmpty(right) &&
            string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
    }

    private static JsonObject MapDataNode(AssetMapPackageData data)
    {
        return new JsonObject
        {
            ["name"] = data.name,
            ["tilemap"] = data.tilemap,
            ["collision"] = data.collision,
            ["attribute"] = data.attribute,
            ["transportation"] = data.transportation,
            ["encount"] = data.encount,
            ["hiddenPassage"] = data.hidden_passage,
            ["damage"] = data.damage,
            ["subCollision"] = data.sub_collision,
            ["entityDefault"] = data.entity_default,
            ["entityCount"] = data.entity == null ? 0 : data.entity.Length,
            ["scriptCount"] = data.script == null ? 0 : data.script.Length,
            ["encountOthersCount"] = data.encount_others == null ? 0 : data.encount_others.Length,
            ["routeInstructionCount"] = data.route_instruction == null ? 0 : data.route_instruction.Length,
        };
    }

    private static JsonObject PackageNode(AssetMapPackage package)
    {
        return new JsonObject
        {
            ["name"] = package.name,
            ["assetGroupName"] = package.asset_group_name,
            ["mapCount"] = package.map == null ? 0 : package.map.Length,
            ["maps"] = MapNames(package),
            ["textureCount"] = package.texture == null ? 0 : package.texture.Length,
        };
    }

    private static AssetMapPackageData FindMapData(
        AssetMapPackage package, MasterMap row, JsonArray names)
    {
        AssetMapPackageData found = null;
        try
        {
            found = package.GetMap(row.MapName);
        }
        catch (Exception)
        {
        }
        for (var i = 0; package.map != null && i < package.map.Length; i++)
        {
            var data = package.map[i];
            if (data == null)
            {
                continue;
            }
            if (names != null)
            {
                names.Add(data.name);
            }
            if (found == null && Same(data.name, row.MapName))
            {
                found = data;
            }
            if (found == null && Same(data.name, row.AssetName))
            {
                found = data;
            }
        }
        // Some packages hold one map and do not key it by the master's map name; use it so the
        // diagnostic can still show the data instead of only saying "not found".
        if (found == null && package.map != null && package.map.Length == 1)
        {
            found = package.map[0];
        }
        return found;
    }

    /// <summary>
    /// A package manifest load shared by mappackage and mapasset. It reuses MapManager's own
    /// packageList when that package is already there, otherwise owns a MapPackageLoader and
    /// disposes it at the end. `MapPackageLoader` is the read-only manifest loader; the
    /// map-switching entry RequestLoadMap is never called.
    /// </summary>
    private sealed class PackageLoad
    {
        private MapPackageLoader _loader;
        private MapPackageData _data;
        private bool _owned;

        public string Group;
        public string PackageName;
        public AssetMapPackage Package;
        public string Source;
        public string Error;

        public PackageLoad(MasterMap row)
        {
            var cached = FindLoaded(CurrentMapManager(), row);
            if (cached != null)
            {
                _data = cached;
                Source = "packageList";
                Adopt();
                return;
            }
            Group = ReadString(() => MapManager.AssetPackageName);
            PackageName = string.IsNullOrEmpty(row.AssetName) ? row.MapName : row.AssetName;
            if (string.IsNullOrEmpty(Group))
            {
                Error = "MapManager.AssetPackageName 为空，无法加载地图包";
                return;
            }
            if (string.IsNullOrEmpty(PackageName))
            {
                Error = "Map.AssetName 和 Map.MapName 都为空，不知道要加载哪个包";
                return;
            }
            _owned = true;
            Source = "MapPackageLoader";
        }

        public bool Poll()
        {
            if (Error != null || Package != null)
            {
                return true;
            }
            if (!_owned)
            {
                Error = "没有已加载的包，也没有可用的加载器";
                return true;
            }
            try
            {
                if (_loader == null)
                {
                    _loader = new MapPackageLoader();
                    _data = _loader.LoadAsset(Group, PackageName);
                }
                _loader.UpdateLoad();
                // Both the loader state and the package data must agree; if the loader reports
                // done before the callback filled Package, waiting one more frame is harmless.
                var complete = _loader.IsCompleted() && (_data == null || _data.IsCompleted());
                if (!complete)
                {
                    return false;
                }
                if (_data == null)
                {
                    Error = "MapPackageLoader.LoadAsset 返回 null";
                    return true;
                }
                Adopt();
                if (Package == null && Error == null)
                {
                    Error = "包清单已加载完，但 Package 仍为空";
                }
                return true;
            }
            catch (Exception e)
            {
                Error = $"{e.GetType().Name}: {e.Message}";
                return true;
            }
        }

        private void Adopt()
        {
            try
            {
                Package = _data?.Package;
                if (Package != null)
                {
                    // The manifest's own group is the one ResourceManager knows its assets by;
                    // keep AssetPackageName only as the fallback used to load the manifest.
                    if (!string.IsNullOrEmpty(Package.asset_group_name))
                    {
                        Group = Package.asset_group_name;
                    }
                    if (string.IsNullOrEmpty(PackageName))
                    {
                        PackageName = Package.name;
                    }
                    if (string.IsNullOrEmpty(Group))
                    {
                        Group = ReadString(() => MapManager.AssetPackageName);
                    }
                }
            }
            catch (Exception e)
            {
                Error = $"{e.GetType().Name}: {e.Message}";
            }
        }

        private static MapPackageData FindLoaded(MapManager manager, MasterMap row)
        {
            var list = manager?.packageList;
            if (list == null)
            {
                return null;
            }
            try
            {
                if (!string.IsNullOrEmpty(row.AssetName) &&
                    list.TryGetValue(row.AssetName, out var exact) && exact?.Package != null)
                {
                    return exact;
                }
            }
            catch (Exception)
            {
            }
            foreach (var pair in list)
            {
                var data = pair.Value;
                if (data == null)
                {
                    continue;
                }
                try
                {
                    if (data.Package != null && data.Package.GetMap(row.MapName) != null)
                    {
                        return data;
                    }
                }
                catch (Exception)
                {
                }
            }
            return null;
        }

        public void Close()
        {
            if (!_owned || _loader == null)
            {
                return;
            }
            try
            {
                _loader.Dispose();
            }
            catch (Exception)
            {
                // The loader may already be gone with a scene change; nothing else to do.
            }
            _loader = null;
        }
    }

    private sealed class MapPackageJob : MapJob
    {
        private readonly MasterMap _row;
        private readonly PackageLoad _package;
        private readonly long _started = Environment.TickCount64;

        public MapPackageJob(MasterMap row)
        {
            _row = row;
            _package = new PackageLoad(row);
        }

        public override bool Poll()
        {
            return _package.Poll();
        }

        public override JsonObject Result(bool timedOut)
        {
            var o = new JsonObject
            {
                ["map"] = MapRowNode(_row),
                ["group"] = _package.Group,
                ["packageName"] = _package.PackageName,
                ["source"] = _package.Source,
                ["timeout"] = timedOut,
                ["elapsedMs"] = Environment.TickCount64 - _started,
            };
            if (_package.Error != null)
            {
                o["error"] = _package.Error;
            }
            if (_package.Package == null)
            {
                o["resources"] = new JsonArray();
                o["mapNames"] = new JsonArray();
                return o;
            }
            o["package"] = PackageNode(_package.Package);
            var names = new JsonArray();
            var data = FindMapData(_package.Package, _row, names);
            o["mapNames"] = names;
            if (data == null)
            {
                o["resources"] = new JsonArray();
                if (_package.Error == null)
                {
                    o["error"] = $"包 {_package.PackageName} 里找不到地图 {_row.MapName}";
                }
                return o;
            }
            o["mapData"] = MapDataNode(data);
            o["resources"] = ResourcesNode(data);
            return o;
        }

        public override void Close()
        {
            _package.Close();
        }
    }

    private static JsonArray ResourcesNode(AssetMapPackageData data)
    {
        var rows = new JsonArray();
        AddScalar(rows, "tilemap", data.tilemap);
        AddScalar(rows, "collision", data.collision);
        AddScalar(rows, "attribute", data.attribute);
        AddScalar(rows, "transportation", data.transportation);
        AddScalar(rows, "encount", data.encount);
        AddScalar(rows, "hidden_passage", data.hidden_passage);
        AddScalar(rows, "damage", data.damage);
        AddScalar(rows, "sub_collision", data.sub_collision);
        AddScalar(rows, "entity_default", data.entity_default);
        AddElements(rows, "entity", data.entity);
        AddElements(rows, "script", data.script);
        AddElements(rows, "encount_others", data.encount_others);
        AddElements(rows, "route_instruction", data.route_instruction);
        return rows;
    }

    private static void AddScalar(JsonArray rows, string field, string asset)
    {
        rows.Add(new JsonObject
        {
            ["name"] = field,
            ["field"] = field,
            ["kind"] = "text",
            ["type"] = "text",
            ["asset"] = string.IsNullOrEmpty(asset) ? null : asset,
            ["present"] = !string.IsNullOrEmpty(asset),
        });
    }

    private static void AddElements(
        JsonArray rows, string field, Il2CppInterop.Runtime.InteropTypes.Arrays.Il2CppReferenceArray<AssetPackageElement> list)
    {
        for (var i = 0; list != null && i < list.Length; i++)
        {
            var element = list[i];
            if (element == null)
            {
                continue;
            }
            var name = string.IsNullOrEmpty(element.name) ? $"{field}[{i}]" : element.name;
            var node = new JsonObject
            {
                ["name"] = name,
                ["field"] = field,
                ["index"] = i,
                ["kind"] = "text",
                ["type"] = "text",
                ["asset"] = string.IsNullOrEmpty(element.asset) ? null : element.asset,
                ["inline"] = !string.IsNullOrEmpty(element.inline),
            };
            if (!string.IsNullOrEmpty(element.inline))
            {
                node["inlineLength"] = element.inline.Length;
            }
            rows.Add(node);
        }
    }

    private sealed class MapAssetJob : MapJob
    {
        private readonly MasterMap _row;
        private readonly string _asset;
        private readonly int _offset;
        private readonly int _limit;
        private readonly PackageLoad _package;
        private readonly long _started = Environment.TickCount64;

        private bool _resolved;
        private bool _requested;
        private bool _fromCache;
        private string _address;
        private string _inline;
        private string _error;
        private TextAsset _text;

        public MapAssetJob(MasterMap row, string asset, int offset, int limit)
        {
            _row = row;
            _asset = asset;
            _offset = offset;
            _limit = limit;
            _package = new PackageLoad(row);
        }

        public override bool Poll()
        {
            if (_text != null || _inline != null || _error != null)
            {
                return true;
            }
            if (!_package.Poll())
            {
                return false;
            }
            if (_package.Package == null)
            {
                if (_package.Error != null)
                {
                    _error = _package.Error;
                }
                return true;
            }
            if (!_resolved)
            {
                var data = FindMapData(_package.Package, _row, null);
                if (data == null)
                {
                    _error = $"包 {_package.PackageName} 里找不到地图 {_row.MapName}";
                    return true;
                }
                Resolve(data);
                if (_error != null || _inline != null)
                {
                    return true;
                }
            }
            if (_text != null)
            {
                return true;
            }
            var resources = ResourceManager.instance;
            if (resources == null)
            {
                _error = "ResourceManager 还没初始化";
                return true;
            }
            try
            {
                if (!_requested)
                {
                    var cached = ReadText(resources);
                    if (cached != null)
                    {
                        _fromCache = true;
                        _text = cached;
                        return true;
                    }
                    resources.RequestLoadAssetBundle<TextAsset>(_package.Group, _address, false);
                    _requested = true;
                    return false;
                }
                if (!Completed(resources))
                {
                    return false;
                }
                _text = ReadText(resources);
                if (_text == null)
                {
                    _error = "资源加载完成，但 GetAssetData<TextAsset> 读不到正文";
                }
                return true;
            }
            catch (Exception e)
            {
                _error = $"{e.GetType().Name}: {e.Message}";
                return true;
            }
        }

        private bool Completed(ResourceManager resources)
        {
            try
            {
                if (!string.IsNullOrEmpty(_package.Group) &&
                    resources.CheckLoadAssetCompleted(_package.Group, _address))
                {
                    return true;
                }
            }
            catch (Exception)
            {
            }
            try
            {
                return resources.CheckLoadAssetCompleted(_address);
            }
            catch (Exception)
            {
                return false;
            }
        }

        private TextAsset ReadText(ResourceManager resources)
        {
            try
            {
                if (!string.IsNullOrEmpty(_package.Group))
                {
                    var text = resources.GetAssetData<TextAsset>(_package.Group, _address);
                    if (text != null)
                    {
                        return text;
                    }
                }
            }
            catch (Exception)
            {
            }
            try
            {
                return resources.GetAssetData<TextAsset>(_address);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private void Resolve(AssetMapPackageData data)
        {
            _resolved = true;
            if (FieldValue(data, _asset, out var field))
            {
                if (string.IsNullOrEmpty(field))
                {
                    _error = $"资源 {_asset} 在清单里是空的";
                    return;
                }
                // A scalar slot is normally an address, but the manifest format allows inline
                // text; a JSON body is not an Addressables address.
                var trimmed = field.TrimStart();
                if (trimmed.StartsWith("{", StringComparison.Ordinal) ||
                    trimmed.StartsWith("[", StringComparison.Ordinal))
                {
                    _inline = field;
                    return;
                }
                _address = field;
                return;
            }
            var element = FindElement(data, _asset);
            if (element != null)
            {
                if (!string.IsNullOrEmpty(element.inline))
                {
                    _inline = element.inline;
                    return;
                }
                var address = ElementAsset(element);
                if (string.IsNullOrEmpty(address))
                {
                    _error = $"资源 {_asset} 是内联/外部元素，但读不到 asset 名";
                    return;
                }
                _address = address;
                return;
            }
            _error = $"地图 {_row.Id}({_row.MapName}) 的清单里没有资源 {_asset}";
        }

        public override JsonObject Result(bool timedOut)
        {
            var o = new JsonObject
            {
                ["map"] = MapRowNode(_row),
                ["asset"] = _asset,
                ["offset"] = _offset,
                ["limit"] = _limit,
                ["group"] = _package.Group,
                ["packageName"] = _package.PackageName,
                ["timeout"] = timedOut,
                ["elapsedMs"] = Environment.TickCount64 - _started,
            };
            if (_package.Error != null)
            {
                o["error"] = _package.Error;
            }
            else if (_error != null)
            {
                o["error"] = _error;
            }
            if (_inline != null)
            {
                o["source"] = "inline";
                Page(o, _inline);
                return o;
            }
            if (_address != null)
            {
                o["assetName"] = _address;
            }
            if (_text == null)
            {
                o["source"] = _fromCache ? "cache" : "TextAsset";
                o["loaded"] = false;
                o["total"] = 0;
                o["offset"] = Math.Max(0, _offset);
                o["length"] = 0;
                o["text"] = "";
                o["truncated"] = false;
                o["nextOffset"] = null;
                return o;
            }
            o["source"] = _fromCache ? "cache" : "TextAsset";
            o["loaded"] = true;
            Page(o, _text.text ?? "");
            return o;
        }

        private void Page(JsonObject o, string full)
        {
            var total = full.Length;
            var offset = Math.Min(Math.Max(0, _offset), total);
            var limit = Math.Clamp(_limit, 1, MapAssetMaxLimit);
            var take = Math.Min(limit, total - offset);
            o["loaded"] = true;
            o["total"] = total;
            o["offset"] = offset;
            o["limit"] = limit;
            o["length"] = take;
            o["text"] = take == 0 ? "" : full.Substring(offset, take);
            o["truncated"] = offset + take < total;
            if (offset + take < total)
            {
                o["nextOffset"] = offset + take;
            }
            else
            {
                o["nextOffset"] = null;
            }
        }

        private static bool FieldValue(AssetMapPackageData data, string name, out string value)
        {
            switch (name.ToLowerInvariant())
            {
                case "tilemap":
                    value = data.tilemap;
                    return true;
                case "collision":
                    value = data.collision;
                    return true;
                case "attribute":
                    value = data.attribute;
                    return true;
                case "transportation":
                    value = data.transportation;
                    return true;
                case "encount":
                    value = data.encount;
                    return true;
                case "hidden_passage":
                    value = data.hidden_passage;
                    return true;
                case "damage":
                    value = data.damage;
                    return true;
                case "sub_collision":
                    value = data.sub_collision;
                    return true;
                case "entity_default":
                    value = data.entity_default;
                    return true;
                default:
                    value = null;
                    return false;
            }
        }

        private static AssetPackageElement FindElement(AssetMapPackageData data, string name)
        {
            var found = FindIn(data.entity, name) ??
                FindIn(data.script, name) ??
                FindIn(data.encount_others, name) ??
                FindIn(data.route_instruction, name);
            if (found != null)
            {
                return found;
            }
            // AddElements labels an unnamed element as "entity[0]"; accept that spelling too.
            var open = name.IndexOf('[');
            if (open <= 0 || !name.EndsWith("]", StringComparison.Ordinal))
            {
                return null;
            }
            var field = name.Substring(0, open);
            if (!int.TryParse(name.Substring(open + 1, name.Length - open - 2), out var index))
            {
                return null;
            }
            switch (field)
            {
                case "entity":
                    return At(data.entity, index);
                case "script":
                    return At(data.script, index);
                case "encount_others":
                    return At(data.encount_others, index);
                case "route_instruction":
                    return At(data.route_instruction, index);
                default:
                    return null;
            }
        }

        private static AssetPackageElement At(
            Il2CppInterop.Runtime.InteropTypes.Arrays.Il2CppReferenceArray<AssetPackageElement> list, int index)
        {
            return list != null && index >= 0 && index < list.Length ? list[index] : null;
        }

        private static AssetPackageElement FindIn(
            Il2CppInterop.Runtime.InteropTypes.Arrays.Il2CppReferenceArray<AssetPackageElement> list, string name)
        {
            for (var i = 0; list != null && i < list.Length; i++)
            {
                var element = list[i];
                if (element != null && (Same(element.name, name) || Same(element.asset, name)))
                {
                    return element;
                }
            }
            return null;
        }

        private static string ElementAsset(AssetPackageElement element)
        {
            try
            {
                var name = AssetMapPackageData.GetAssetName(element);
                if (!string.IsNullOrEmpty(name))
                {
                    return name;
                }
            }
            catch (Exception)
            {
            }
            if (!string.IsNullOrEmpty(element.asset))
            {
                return element.asset;
            }
            return element.name;
        }

        public override void Close()
        {
            _package.Close();
        }
    }
}
#endif
