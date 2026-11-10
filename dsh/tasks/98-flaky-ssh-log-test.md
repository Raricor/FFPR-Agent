# 任务 98:修偶发失败的测试 “two calls that find the agent gone share one restart”

工作目录 `dsh/`。只许改 `test/link-pilot.test.ts`(必要时改它用到的测试替身文件);不改 `src/`。不碰 git,不连笔记本,**不用 docker、不绕开沙箱**。

## 起因

11-10 整套测试一起跑、机器忙时，这个测试偶尔失败:

```
✖ two calls that find the agent gone share one restart
  SyntaxError: Unterminated string in JSON at position 277
      at readSshLog (test/link-pilot.test.ts:805)
      at waitForSshCalls (test/link-pilot.test.ts:783)
```

另有一句 “generated asynchronous activity after the test ended ... spawn .../ssh-first.sh ENOENT ... unhandledRejection”。单独跑 3 次都过。看起来是读假 ssh 日志时读到了写了一半的一行，或者测试结束后还有子进程在跑、临时目录已被删。

## 做法

1. `readSshLog`:只解析以换行结尾的完整行，最后一行不完整就忽略(等下一次再读);`waitForSshCalls` 照旧轮询。
2. 测试结束前等所有发出的调用都结束(或者取消并等它们落地),再删临时目录，不留下测试结束后的异步活动。
3. 用 `node --test --test-concurrency=…` 或循环跑这个文件 30 次，都不失败;整套 `npm run check` 全过。

## 回报

不超过 15 行：根因、改了什么、循环跑的结果、`npm run check` 结尾。
