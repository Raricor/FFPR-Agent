using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BepInEx.Logging;

namespace FfprBridge;

/// <summary>
/// The LAN link (control plan §5): which address to listen on, which clients may connect, and
/// the token every request must carry. Read from a JSON file the dev box writes over SSH:
///
///   {"listen": "192.168.8.230", "allow": ["192.168.8.229"], "token": "..."}
///
/// No file, or a bad one, means no LAN listener: the bridge then only listens on 127.0.0.1,
/// as before 0.5.0.
/// </summary>
internal sealed class Link
{
    private const int MinTokenLength = 32;

    private readonly byte[] _token;
    private readonly HashSet<IPAddress> _allow;

    private Link(IPAddress listen, HashSet<IPAddress> allow, byte[] token)
    {
        Listen = listen;
        _allow = allow;
        _token = token;
    }

    public IPAddress Listen { get; }

    public static Link Load(string path, ManualLogSource log)
    {
        if (!File.Exists(path))
        {
            log.LogInfo($"没有 {path},不开局域网连接");
            return null;
        }
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            var root = doc.RootElement;
            var listen = IPAddress.Parse(root.GetProperty("listen").GetString() ?? "");
            if (IPAddress.IsLoopback(listen) || listen.Equals(IPAddress.Any) || listen.Equals(IPAddress.IPv6Any))
            {
                throw new FormatException("listen 要填局域网地址,不能是本机或所有网卡");
            }
            var allow = new HashSet<IPAddress>();
            foreach (var a in root.GetProperty("allow").EnumerateArray())
            {
                allow.Add(IPAddress.Parse(a.GetString() ?? ""));
            }
            if (allow.Count == 0)
            {
                throw new FormatException("allow 不能为空");
            }
            var token = root.GetProperty("token").GetString() ?? "";
            if (token.Length < MinTokenLength)
            {
                throw new FormatException($"token 至少 {MinTokenLength} 个字符");
            }
            return new Link(listen, allow, Encoding.UTF8.GetBytes(token));
        }
        catch (Exception e)
        {
            log.LogWarning($"{path} 读不了,不开局域网连接:{e.Message}");
            return null;
        }
    }

    public bool Allows(IPAddress remote)
    {
        if (remote.IsIPv4MappedToIPv6)
        {
            remote = remote.MapToIPv4();
        }
        return _allow.Contains(remote);
    }

    /// <summary>Checks an Authorization header value ("Bearer ...") in constant time.</summary>
    public bool Authorized(string header)
    {
        const string scheme = "Bearer ";
        if (header == null || !header.StartsWith(scheme, StringComparison.Ordinal))
        {
            return false;
        }
        var given = Encoding.UTF8.GetBytes(header[scheme.Length..].Trim());
        return CryptographicOperations.FixedTimeEquals(given, _token);
    }
}
