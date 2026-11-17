# newifi3-d2 自编译固件

OpenWrt **25.12.6**（当前 stable）+ Image Builder，Newifi-D2（D-Team / MT7621AT / 32MB NAND / 512MB RAM）。
只装这台机器真正要用的东西，其余全部剔掉，把空间留给 overlay。

## 怎么出固件

仓库 Actions → `build-newifi-d2` → **Run workflow**，10–15 分钟（要下 SDK 200MB + ImageBuilder 176MB）。
产物在 run 页面的 Artifacts：`newifi-d2-sysupgrade` → `openwrt-25.12.6-ramips-mt7621-d-team_newifi-d2-squashfs-sysupgrade.bin`。

改 `files/` 下任何东西 push 到 `main` 会自动重编。

## 相比官方默认镜像做了什么

### 装上的

| 包 | 用途 |
|---|---|
| `luci-ssl` | 管理后台（含 uhttpd + HTTPS） |
| `curl` + `ca-bundle` | 代理服务开机拉二进制要用 |
| `vlmcsd` | **KMS 激活服务**，监听 `1688`（官方源没有这个包，CI 里用 SDK 的 musl 工具链从源码编，KMS 数据内嵌，不依赖 `/etc/vlmcsd.kmd`） |

### 剔掉的（约省 2.9 MB）

| 剔除 | 体积 | 为什么 |
|---|---|---|
| `wpad-basic-mbedtls` | ~950 KB | 没有 wifi 就不需要 supplicant/hostapd |
| `kmod-mt7603` `kmod-mt76x2` `kmod-mac80211` `kmod-cfg80211` | ~1.4 MB | 5G/2.4G 驱动整套，这台只当有线路由 |
| `kmod-usb3` `kmod-usb-ledtrig-usbport` | ~35 KB | 不接 USB |
| `ppp` `ppp-mod-pppoe` | ~370 KB | WAN1 是 DHCP、WAN2 是静态，不拨号 |
| `odhcpd-ipv6only` | ~140 KB | 不做 IPv6 服务端（`odhcp6c` 客户端保留） |

省下来的空间直接进 overlay，装包/存配置更宽裕。CI 里有一条硬校验：如果 wifi 驱动、wpad、ppp 还在镜像里，构建直接失败。

### 预置的配置

`files/etc/uci-defaults/99-newifi-custom` 只在**首启执行一次**，跑完 OpenWrt 自己把它删掉，不会每次开机重跑。

| 项 | 值 |
|---|---|
| LAN | `172.20.0.1/24`（DHCP 池保持默认 `172.20.0.100–249`） |
| WAN1（`wan` / port4） | 保持固件默认 `dhcp`，不动 |
| WAN2（`wan2` / `lan1`） | `static 192.168.116.253/24`，从 `br-lan` 里摘出来 |
| 4 条静态路由 | 见下，全部经 `192.168.116.250` |
| 防火墙 | `wan` 区纳入 `wan2`；放行 `tcp/1089`、`tcp/1688`，`src_ip 192.168.0.0/16` |
| DNS | `kms.lan` → `172.20.0.1` |
| 代理服务 | `/etc/init.d/proxy-mipsle`，开机从 NAS 拉到 `/tmp` 跑，`0.0.0.0:1089` |
| KMS 服务 | `/etc/init.d/vlmcsd`，`/usr/bin/vlmcsd -D -e -P 1688` |
| wifi | 关掉（驱动本来也没装） |
| 软件源 | `downloads.openwrt.org` → `mirrors.ustc.edu.cn/openwrt` |

4 条路由：

```
192.168.0.0/16      192.168.116.250
59.227.152.125/32   192.168.116.250
10.85.200.100/32    192.168.116.250
10.85.200.99/32     192.168.116.250
```

**route target 必须写 CIDR**，老写法（`target` + 单独 `netmask`）会被静默丢弃，`ip route` 里连报错都看不到。

## 25.12 是 DSA，不是 swconfig

官方 24.10 起 ramips/mt7621 就是 DSA，网口直接叫 `lan1~lan4` / `wan`，**不需要** VLAN 那套 swconfig 操作。
设备树里 `port@3 = lan1` —— 就是原来 swconfig 固件上的 switch port 3，插 WAN2 的线还是那根口。

物理口标号仍然只能拔插实测：

```sh
for p in lan1 lan2 lan3 lan4 wan; do
	printf '%s: ' $p; cat /sys/class/net/$p/carrier 2>/dev/null || echo -
done
```

## 刷完要做的两件事

1. **设 root 密码。** 固件里没有密码，dropbear 空密码不让登录。浏览器开 `http://172.20.0.1`，LuCI 首登会强制设密码。
2. **确认 WAN2 那根网线在 `lan1` 上。** 上面那条 `carrier` 命令能看出来；不在就改 `files/etc/uci-defaults/99-newifi-custom` 里的 `network.wan2.device`，重编。

## KMS 怎么用

服务端在路由器上，端口 1688。客户端（Windows / Office）指过来就行：

```bat
:: Windows
slmgr /skms kms.lan:1688
slmgr /ato

:: Office（管理员 cmd，路径按实际版本）
cd C:\Program Files\Microsoft Office\Office16
cscript ospp.vbs /sethst:kms.lan
cscript ospp.vbs /act
```

`kms.lan` 由路由器 dnsmasq 直接答 `172.20.0.1`；不走 DNS 就直接写 `172.20.0.1:1688`。
办公网那侧（`192.168.0.0/16`）用 `192.168.116.253:1688`，防火墙已经放行。

看激活请求有没有进来：`logread -e vlmcsd | tail`。

## 验证

```sh
ip -4 -o addr show | grep -v 127.0.0.1     # 三个地址对不对
ip route get 10.85.200.99                  # 是否走 wan2
ls /lib/modules/*/ | grep -c mt76          # 应该是 0，wifi 驱动确实没了
logread -e proxy-mipsle | tail             # 代理二进制拉下来没有
netstat -lntp | grep 1688                  # KMS 在听
curl -x http://cl:cl@172.20.0.1:1089 -sI https://www.baidu.com | head -1
```

## 目录

```
.github/workflows/build.yml               SDK 工具链编 vlmcsd → ImageBuilder 出固件 → 内容校验
files/etc/uci-defaults/99-newifi-custom   首启一次性配置
files/etc/init.d/vlmcsd                   KMS 服务
files/etc/init.d/proxy-mipsle             代理服务（下载 + 运行合一，二进制不落闪存）
files/usr/bin/vlmcsd                      CI 里现编，不进版本库（.gitignore）
```

`.gitattributes` 强制 LF。**shell 脚本被 checkout 成 CRLF 会直接跑挂**，别改成 `core.autocrlf=true` 那一套。
`99-newifi-custom` / `vlmcsd` / `proxy-mipsle` 必须保持 `100755`。

## vlmcsd 怎么编的

不走它的 GNUmakefile —— 那玩意儿是 BSD make 语法，GNU make 进去会去调 `gmake`，Ubuntu runner 上没有这个命令，直接 command not found。改成直接列源码调交叉 gcc，参数对齐上游 `BASECFLAGS`：

```
-D_CRYPTO_INTERNAL     自带 AES，不链接 openssl
-DFULL_INTERNAL_DATA   把 15085 字节完整 KMS 数据编进去 → 运行时不找 vlmcsd.kmd
```

编完硬校验四件事，任一不满足就让构建失败：ELF32、小端、`e_machine=8`(MIPS)、解释器是 musl；再查 KMS 数据的头尾各 32 字节确实在二进制里（防止数据没内嵌全，刷完开机才发现）。
