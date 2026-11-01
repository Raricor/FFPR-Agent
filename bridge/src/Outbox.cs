using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using BepInEx.Logging;

namespace FfprBridge;

/// <summary>
/// Carries JSON lines off the game thread. A background thread appends them to the probe file
/// and broadcasts them to WebSocket clients; the game thread only enqueues strings and never
/// waits on I/O. Clients may also send queries, which wait in <see cref="Requests"/> until the
/// game thread answers them through <see cref="Reply"/>, and (on the LAN link only) key
/// commands for <see cref="Keyboard"/>. Nothing here touches IL2CPP objects.
///
/// Two listeners on the same port:
///   127.0.0.1    the pilot agent on the laptop; "/" streams, "/query" queries; no token, except
///                "/command" (keys), which needs the LAN link's token (0.8.9)
///   LAN address  the dev box (control plan §5), only when <see cref="Link"/> is configured:
///                the client's address must be allowed and every request must carry the token.
///                GET /v1/health, and WebSockets /v1/stream, /v1/query, /v1/command
/// </summary>
internal sealed class Outbox
{
    private const string WebSocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private const int Capacity = 10000;

    private const int MaxRequestBytes = 64 * 1024;

    // To == null: a record for the file and every client; otherwise a reply for one client.
    private readonly BlockingCollection<(string Line, WebSocket To)> _queue =
        new(new ConcurrentQueue<(string, WebSocket)>(), Capacity);

    // 0.12.0: every connection is listed for the laptop's tray app, with the address, the channel
    // it came in on and when it arrived. Only stream clients get the broadcast.
    private readonly List<Client> _clients = new();
    private readonly string _file;
    private readonly int _port;
    private readonly Link _link;
    private readonly ManualLogSource _log;
    private long _dropped;

    private enum Channel
    {
        Stream,
        Query,
        Command,
    }

    private sealed class Client
    {
        public WebSocket Socket;
        public string Remote;
        public Channel Channel;
        public DateTime Since;
    }

    public Outbox(string file, int port, Link link, ManualLogSource log)
    {
        _file = file;
        _port = port;
        _link = link;
        _log = log;
    }

    /// <summary>Lines lost because the queue was full; reported in every sample.</summary>
    public long Dropped => Interlocked.Read(ref _dropped);

    public int Port => _port;

    public Link Lan => _link;

    /// <summary>The connections the tray app's "bridge" query reports, in the order they arrived.</summary>
    public JsonArray Clients()
    {
        var array = new JsonArray();
        lock (_clients)
        {
            foreach (var client in _clients)
            {
                array.Add(new JsonObject
                {
                    ["remote"] = client.Remote,
                    ["channel"] = client.Channel.ToString().ToLowerInvariant(),
                    ["since"] = client.Since.ToString("O"),
                });
            }
        }
        return array;
    }

    /// <summary>The address a key command's client came from, for the keys record.</summary>
    public string RemoteOf(WebSocket socket)
    {
        lock (_clients)
        {
            foreach (var client in _clients)
            {
                if (client.Socket == socket)
                {
                    return client.Remote;
                }
            }
        }
        return null;
    }

    /// <summary>Sent first to every client that connects, so it knows what it is talking to.</summary>
    public volatile string Hello;

    /// <summary>Queries from clients, answered on the game thread.</summary>
    public readonly ConcurrentQueue<(WebSocket From, string Text)> Requests = new();

    public void Post(string line)
    {
        if (!_queue.TryAdd((line, null)))
        {
            Interlocked.Increment(ref _dropped);
        }
    }

    public void Reply(WebSocket to, string line)
    {
        if (!_queue.TryAdd((line, to)))
        {
            Interlocked.Increment(ref _dropped);
        }
    }

    public void Start()
    {
        new Thread(WriteLoop) { IsBackground = true, Name = "FfprBridge.Outbox" }.Start();
        if (_port <= 0)
        {
            return;
        }
        new Thread(() => AcceptLoop(IPAddress.Loopback, false)) { IsBackground = true, Name = "FfprBridge.WebSocket" }.Start();
        if (_link != null)
        {
            new Thread(() => AcceptLoop(_link.Listen, true)) { IsBackground = true, Name = "FfprBridge.Lan" }.Start();
        }
    }

    private void WriteLoop()
    {
        try
        {
            // FileShare.Read: the dev box copies the file over SSH while the game is running.
            var stream = new FileStream(_file, FileMode.Append, FileAccess.Write, FileShare.Read);
            using var writer = new StreamWriter(stream, new UTF8Encoding(false));
            foreach (var (line, to) in _queue.GetConsumingEnumerable())
            {
                if (to != null)
                {
                    if (to.State == WebSocketState.Open && !TrySend(to, Encoding.UTF8.GetBytes(line)))
                    {
                        DropSocket(to);
                    }
                    continue;
                }
                writer.WriteLine(line);
                Broadcast(line);
                if (_queue.Count == 0)
                {
                    writer.Flush();
                }
            }
        }
        catch (Exception e)
        {
            _log.LogError($"写日志线程退出:{e}");
        }
    }

    private void Broadcast(string line)
    {
        Client[] clients;
        lock (_clients)
        {
            if (_clients.Count == 0)
            {
                return;
            }
            clients = _clients.FindAll(c => c.Channel == Channel.Stream).ToArray();
        }
        var bytes = Encoding.UTF8.GetBytes(line);
        foreach (var client in clients)
        {
            if (!TrySend(client.Socket, bytes))
            {
                Drop(client);
            }
        }
    }

    private static bool TrySend(WebSocket ws, byte[] bytes)
    {
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            ws.SendAsync(bytes, WebSocketMessageType.Text, true, timeout.Token).Wait();
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private void Drop(Client client)
    {
        lock (_clients)
        {
            _clients.Remove(client);
        }
        client.Socket.Abort();
        client.Socket.Dispose();
    }

    /// <summary>A reply whose client is gone; the socket need not still be in the list.</summary>
    private void DropSocket(WebSocket socket)
    {
        Client found = null;
        lock (_clients)
        {
            foreach (var client in _clients)
            {
                if (client.Socket == socket)
                {
                    found = client;
                    break;
                }
            }
        }
        if (found != null)
        {
            Drop(found);
            return;
        }
        socket.Abort();
        socket.Dispose();
    }

    private void AcceptLoop(IPAddress address, bool lan)
    {
        // Another program may hold the port (VS Code forwarding 47800 did, 10-20): keep trying,
        // so freeing it is enough and the game need not restart.
        TcpListener listener = null;
        for (var attempt = 1; listener == null; attempt++)
        {
            try
            {
                listener = new TcpListener(address, _port);
                listener.Start();
            }
            catch (Exception e)
            {
                listener = null;
                if (attempt == 1)
                {
                    _log.LogWarning($"端口 {address}:{_port} 打不开,每 5 秒重试:{e.Message}");
                }
                Thread.Sleep(5000);
            }
        }
        _log.LogInfo($"监听 ws://{address}:{_port}/" + (lan ? "(局域网,需要令牌)" : ""));
        while (true)
        {
            try
            {
                var tcp = listener.AcceptTcpClient();
                _ = Task.Run(() => Serve(tcp, lan));
            }
            catch (Exception e)
            {
                _log.LogWarning($"接受连接失败:{e.Message}");
                Thread.Sleep(1000);
            }
        }
    }

    private async Task Serve(TcpClient tcp, bool lan)
    {
        WebSocket ws = null;
        try
        {
            tcp.NoDelay = true;
            if (lan && !_link.Allows(((IPEndPoint)tcp.Client.RemoteEndPoint).Address))
            {
                return;  // not the dev box: close without a word
            }
            var stream = tcp.GetStream();
            var (path, headers) = ReadRequest(stream);
            if (lan && !_link.Authorized(headers.GetValueOrDefault("authorization")))
            {
                await Respond(stream, "401 Unauthorized", "{\"ok\":false,\"error\":\"unauthorized\"}");
                return;
            }
            // 10-27: the pilot agent's own loops (walk, battle, story) press the virtual gamepad too,
            // so the game plays in the background; the LAN link's token guards keys here as well.
            if (!lan && path == "/command" && (_link == null || !_link.Authorized(headers.GetValueOrDefault("authorization"))))
            {
                await Respond(stream, "401 Unauthorized", "{\"ok\":false,\"error\":\"unauthorized\"}");
                return;
            }
            if (path == "/v1/health")
            {
                await Respond(stream, "200 OK", Health());
                return;
            }
            Channel? channel = (lan, path) switch
            {
                (_, "/v1/stream") => Channel.Stream,
                (_, "/v1/query") => Channel.Query,
                (true, "/v1/command") => Channel.Command,
                (false, "/query") => Channel.Query,
                (false, "/command") => Channel.Command,
                (false, _) => Channel.Stream,
                _ => null,
            };
            var key = headers.GetValueOrDefault("sec-websocket-key");
            if (channel == null || key == null)
            {
                await Respond(stream, "404 Not Found", "{\"ok\":false,\"error\":\"not_found\"}");
                return;
            }
            var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key + WebSocketGuid)));
            var response = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                + $"Sec-WebSocket-Accept: {accept}\r\n\r\n";
            await stream.WriteAsync(Encoding.ASCII.GetBytes(response));

            ws = WebSocket.CreateFromStream(stream, true, null, TimeSpan.FromSeconds(30));
            var client = new Client
            {
                Socket = ws,
                Remote = tcp.Client.RemoteEndPoint?.ToString(),
                Channel = channel.Value,
                Since = DateTime.UtcNow,
            };
            lock (_clients)
            {
                _clients.Add(client);
            }
            var hello = Hello;
            if (hello != null && !TrySend(ws, Encoding.UTF8.GetBytes(hello)))
            {
                return;
            }

            // Reading also keeps pings answered and notices when the client leaves.
            var buffer = new byte[4096];
            using var message = new MemoryStream();
            while (ws.State == WebSocketState.Open)
            {
                var result = await ws.ReceiveAsync(buffer, CancellationToken.None);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    break;
                }
                if (message.Length + result.Count <= MaxRequestBytes)
                {
                    message.Write(buffer, 0, result.Count);
                }
                if (result.EndOfMessage)
                {
                    if (result.MessageType == WebSocketMessageType.Text && message.Length <= MaxRequestBytes)
                    {
                        var text = Encoding.UTF8.GetString(message.ToArray());
                        if (channel == Channel.Command)
                        {
                            Keyboard.Enqueue(ws, text);
                        }
                        else if (channel == Channel.Query)
                        {
                            Requests.Enqueue((ws, text));
                        }
                    }
                    message.SetLength(0);
                }
            }
        }
        catch (Exception)
        {
            // A client that vanishes mid-frame is normal; nothing to report.
        }
        finally
        {
            if (ws != null)
            {
                lock (_clients)
                {
                    _clients.RemoveAll(c => c.Socket == ws);
                }
                ws.Dispose();
            }
            tcp.Close();
        }
    }

    private string Health()
    {
        var clients = 0;
        lock (_clients)
        {
            foreach (var client in _clients)
            {
                if (client.Channel == Channel.Stream)
                {
                    clients++;
                }
            }
        }
        var hello = Hello ?? "null";
        return $"{{\"ok\":true,\"frame\":{Probe.Frame},\"clients\":{clients},\"dropped\":{Dropped},\"hello\":{hello}}}";
    }

    private static async Task Respond(Stream stream, string status, string json)
    {
        var body = Encoding.UTF8.GetBytes(json);
        var head = $"HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\n"
            + $"Content-Length: {body.Length}\r\nConnection: close\r\n\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(head));
        await stream.WriteAsync(body);
    }

    /// <summary>Reads an HTTP request head; returns its path (without the query string) and
    /// its headers with lower-case names.</summary>
    private static (string Path, Dictionary<string, string> Headers) ReadRequest(Stream stream)
    {
        var header = new StringBuilder();
        var headers = new Dictionary<string, string>();
        while (header.Length < 8192)
        {
            var b = stream.ReadByte();
            if (b < 0)
            {
                return ("/", headers);
            }
            header.Append((char)b);
            if (header.Length >= 4 && header.ToString(header.Length - 4, 4) == "\r\n\r\n")
            {
                break;
            }
        }
        var lines = header.ToString().Split("\r\n");
        var request = lines[0].Split(' ');
        var path = request.Length > 1 ? request[1] : "/";
        var question = path.IndexOf('?');
        if (question >= 0)
        {
            path = path[..question];
        }
        foreach (var line in lines[1..])
        {
            var colon = line.IndexOf(':');
            if (colon > 0)
            {
                headers[line[..colon].Trim().ToLowerInvariant()] = line[(colon + 1)..].Trim();
            }
        }
        return (path, headers);
    }
}
