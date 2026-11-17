# newifi3-d2 自编译固件

OpenWrt 24.10.3 + Image Builder，Newifi-D2（D-Team，MT7621AT / 32MB NAND / 512MB RAM）。
固件里只预置这台机器真实在用的配置，别的一律不加。

## 怎么出固件

仓库 Actions → `build-newifi-d2` → **Run workflow**，约 6–10 分钟。
产物在 run 页面的 Artifacts：`newifi-d2-sysupgrade`，里面是一个 `*-squashfs-sysupgrade.bin`。

改 `files/` 下的东西 push 到 `main` 会自动重新编译。

## 固件里到底改了什么

`files/etc/uci-defaults/99-newifi-custom` 只在**首启执行一次**，跑完 OpenWrt 自己把它删掉，不会每次开机重复。

| 项 | 值 |
|---|---|
| LAN | `172.20.0.1/24`（DHCP 池保持默认 `172.20.0.100–249`） |
| WAN1（`wan` / port4） | 保持固件默认 `dhcp`，不动 |
| WAN2（`wan2` / `lan1`） | `static 192.168.116.253/24`，从 `br-lan` 里摘出来 |
| 4 条静态路由 | 见下，全部经 `192.168.116.250` |
| 防火墙 | `wan` 区纳入 `wan2`；放行 `tcp/1089`，`src_ip 192.168.0.0/16` |
| 代理服务 | `/etc/init.d/proxy-mipsle`，开机从 NAS 拉到 `/tmp` 跑，监听 `0.0.0.0:1089` |
| wifi | 首启关掉（这台只当有线路由） |

4 条路由：

```
192.168.0.0/16      192.168.116.250
59.227.152.125/32   192.168.116.250
10.85.200.100/32    192.168.116.250
10.85.200.99/32     192.168.116.250
```

**路由 target 必须写 CIDR**，老写法（`target` + 单独 `netmask`）会被静默丢弃，`ip route` 里连报错都看不到。

## 24.10 是 DSA，不是 swconfig

官方 24.10 的 ramips/mt7621 已经是 DSA，网口直接叫 `lan1~lan4` / `wan`，**不需要** VLAN 那套 swconfig 操作。
设备树里 `port@3 = lan1` —— 也就是原来 swconfig 固件上的 switch port 3，插 WAN2 的线还是那根口。

物理口标号仍然只能拔插实测：

```sh
for p in lan1 lan2 lan3 lan4 wan; do
	printf '%s: ' $p; cat /sys/class/net/$p/carrier 2>/dev/null || echo -
done
```

## 刷完要做的两件事

1. **设 root 密码。** 固件里没有密码，dropbear 空密码不让登录。浏览器开 `http://172.20.0.1`，LuCI 首登会强制设密码。
2. **确认 WAN2 那根网线在 `lan1` 上。** 上面那条 `carrier` 命令能看出来；不在就改 `files/etc/uci-defaults/99-newifi-custom` 里的 `network.wan2.device`，重编。

其余不用动，开机就是配好的状态。

## 验证

```sh
ip -4 -o addr show | grep -v 127.0.0.1     # 三个地址对不对
ip route get 10.85.200.99                  # 是否走 wan2
logread -e proxy-mipsle | tail             # 代理二进制拉下来没有
curl -x http://cl:cl@172.20.0.1:1089 -sI https://www.baidu.com | head -1
```

## 目录

```
.github/workflows/build.yml          Image Builder 云编译
files/etc/uci-defaults/99-newifi-custom   首启一次性配置（网络/防火墙/代理/wifi）
files/etc/init.d/proxy-mipsle       代理服务（下载 + 运行合一，二进制不落闪存）
```

`.gitattributes` 强制 LF。**shell 脚本被 checkout 成 CRLF 会直接跑挂**，别改成 `core.autocrlf=true` 那一套。
`99-newifi-custom` 和 `proxy-mipsle` 必须保持 `100755`。
