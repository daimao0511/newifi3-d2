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
| `openssh-sftp-server` | **SFTP 文件传输**（113 KB）。dropbear 只做 SSH 外壳，收到 `subsystem sftp` 请求时 exec 编译期写死的 `/usr/lib/sftp-server`，缺了它 WinSCP/MobaXterm 只能走 SCP |
| `sqm-scripts` + `luci-app-sqm` + `tc-tiny` + `kmod-sched-cake` + `kmod-ifb` | **SQM 流量整形**（cake），治 bufferbloat |
| `iptables-nft` + `iptables-mod-ipopt` | `sqm-scripts` 的硬依赖（`piece_of_cake` 本身不调 iptables，但包定义里写了） |
| `vlmcsd` | **KMS 激活服务**，监听 `1688`（官方源没有这个包，CI 里用 SDK 的 musl 工具链从源码编，KMS 数据内嵌，不依赖 `/etc/vlmcsd.kmd`）；配一个自写 LuCI 页面，菜单在「服务 → KMS 激活」 |
| `busybox ntpd`（自带） | **NTP 服务端**，监听 `123/udp`，内网机器统一向路由器校时 |

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
| 防火墙 | `wan` 区纳入 `wan2`；放行 `tcp/1089`、`tcp/1688`、`udp/123`，`src_ip 192.168.0.0/16`；**关掉 flow offloading**（它和 SQM 互斥） |
| DNS | `kms.lan` → `172.20.0.1` |
| 代理服务 | `/etc/init.d/proxy-mipsle`，开机从 NAS 拉到 `/tmp` 跑，`0.0.0.0:1089` |
| KMS 服务 | `/etc/init.d/vlmcsd`，`/usr/bin/vlmcsd -D -e -P 1688` |
| SQM 整形 | `wan` 上跑 cake，下行 `100000` / 上行 `100000` kbit/s（激进模式，按线路上限 100M 设），进出双向 |
| NTP 服务端 | `enable_server=1`，上游换 `ntp.aliyun.com` / `ntp.tencent.com` / `ntp.ntsc.ac.cn` |
| wifi | 关掉（驱动本来也没装） |
| root 密码 | 空密码时设成 `password`（已有密码不覆盖），dropbear 显式开密码认证 |
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

## 刷完要做的事

1. **改 root 密码。** 首启时如果密码为空，`99-newifi-custom` 已经自动设成 `password`（已有密码则不覆盖），SSH 和 LuCI 都能进；但这是公开的弱密码，**刷完请立刻改**：LuCI → 系统 → 管理权，或 `passwd root`。
2. **确认 WAN2 那根网线在 `lan1` 上。** 上面那条 `carrier` 命令能看出来；不在就改 `files/etc/uci-defaults/99-newifi-custom` 里的 `network.wan2.device`，重编。

## SQM 怎么调

`sqm-scripts` 只是执行器，真正起作用的是 cake 和那两个数字。**数字填错是这套东西唯一会翻车的地方**：

| 填法 | 后果 |
|---|---|
| **大于**真实带宽 | 整形器不触发，等于没开，延迟该炸还是炸 |
| **小于**真实带宽 | 不丢包但峰值被压住，延迟确实变好 |

出厂预设 `download=100000` / `upload=100000`（kbit/s）——**激进模式**：直接按 WAN
百兆协商的上限设，等于让 cake 平时只挂名、基本不介入，峰值带宽完全跑满。
代价是 bufferbloat 治理效果打折：满速下载时延迟压不到十几毫秒那个水平了。

这台机器的实测基线（调回保守值时用）：

| 项 | 实测 | 依据 |
|---|---|---|
| 下行 | 9.38 MB/s ≈ **75 Mbit/s** | 停掉整形后从阿里 / 清华源拉大文件，稳态一致 |
| 上行 | 6 路并发 7.6 MB/s ≈ **61 Mbit/s** | 单连接只能测出 6.7 M，是 TCP 窗口限制，不是带宽 |
| 物理口 | 100 Mbps 全双工 | `ethtool wan` 协商结果，与 75/61 吻合 |

两种填法的取舍：

| 填法 | 峰值带宽 | 满速时延迟 |
|---|---|---|
| `100000 / 100000`（当前，激进） | 完全跑满 | bufferbloat 回来，延迟涨明显 |
| `70000 / 56000`（实测 × 0.92，保守） | 峰值被压到 ~92% | ping 只涨 1~2ms，远程桌面/游戏丝滑 |

延迟敏感（远程桌面 UU / 游戏）就把值调回 70000/56000；只要吞吐就是现在的 100000/100000。

**这一条踩过坑，必须记住**：曾经沿用更早一次「12 Mbps」的旧测量填 `10500 / 3000`，等于把 75M 的下行压到 1/7、上行压到 1/20 —— 出口队列 4 小时丢 9.7 万包、`pk_delay` 峰值 64ms、cake 内存用满 4.3MB/4MB，表现就是远程桌面（UU）卡成幻灯片。改成 70000/56000 后：下载 1.14 → 7.69 MB/s，满速下载 ping 只涨 1.4ms，丢包 97327 → 3。

**换线路 / 换套餐后必须重测，别沿用文档里的数字：**

```sh
# 1) 先停整形，测裸带宽（不停的话测出来的就是设定值）
uci set sqm.@queue[0].enabled='0'; uci commit sqm; /etc/init.d/sqm restart
# 下行：拉一个大文件，看稳态 MB/s
curl -o /dev/null https://mirrors.ustc.edu.cn/openwrt/releases/25.12.6/targets/ramips/mt7621/openwrt-25.12.6-ramips-mt7621-rootfs.tar.gz
# 上行：单连接测不准，用 6 路并发（mwan3 / 多线程工具都行），总计就是真实上行
# 2) 满速下载时 ping 一下网关外，确认 bufferbloat：+5ms 以内算好
ping -c 30 223.5.5.5
# 3) 恢复整形并填新值（吞吐优先填 100000/100000，延迟优先填 70000/56000）
uci set sqm.@queue[0].enabled='1'
uci set sqm.@queue[0].download='100000'
uci set sqm.@queue[0].upload='100000'
uci commit sqm && /etc/init.d/sqm restart
```

改起来**不用重编固件**，LuCI → 网络 → SQM QoS 里也能改，点「应用」立即生效。

确认真的在整形：

```sh
tc -s qdisc show dev wan        # 有 cake，Sent 字节在涨
tc -s qdisc show dev ifb4wan    # 下行整形跑在 ifb 上
logread -e sqm | tail
```

跑一次测速，看 `tc -s qdisc show dev wan` 里 `Sent` 的增速 ≈ 设定的 upload，说明整形在工作。`tc -s qdisc show dev wan` 里 `dropped` 应该是**个位数或零**；如果几小时就上万，说明 download/upload 填大了，或者上游本来就在丢。

不想用了：LuCI 里取消「Enable this SQM instance」，或 `uci set sqm.@queue[0].enabled='0'; uci commit sqm`。

因为 cake 会接管 qdisc，**flow offloading 必须关着**（`99-newifi-custom` 里已显式写 0）。哪天手动打开 offloading，SQM 会立刻变成摆设。

## NTP 服务端

`enable_server=1` 之后 busybox ntpd 带 `-l` 启动，监听 `0.0.0.0:123/udp`。
客户端指到 `172.20.0.1` 即可；办公网那侧用 `192.168.116.253`，防火墙已放行 `udp/123`。

```bat
:: Windows（管理员）
w32tm /config /manualpeerlist:"172.20.0.1" /syncfromflags:manual /update
w32tm /resync
w32tm /stripchart /computer:172.20.0.1 /samples:3
```

```ini
# Linux systemd-timesyncd: /etc/systemd/timesyncd.conf
[Time]
NTP=172.20.0.1
```

路由器上验证：

```sh
pgrep -a ntpd                 # 应该能看到 -l 参数
netstat -lnup | grep :123
```

开源节流的理由：KMS 激活对时间敏感，客户端与服务器偏差超过 4 小时直接失败；内网机器统一向路由器校时，比各自去连公网 NTP 稳。

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

### LuCI 里的「服务 → KMS 激活」

官方源里没有 `luci-app-vlmcsd`（`apk search vlmcsd` 是空的），vlmcsd 只是我们编的一个后台服务，所以默认没有菜单。这里自己写了一个轻量页面，随固件预置，四个文件加起来 5 KB 出头：

| 文件 | 作用 |
|---|---|
| `etc/config/vlmcsd` | 配置：`enabled` / `listen` / `port` |
| `etc/init.d/vlmcsd` | 从 uci 读参数启动，端口非法自动退回 1688 |
| `www/luci-static/resources/view/vlmcsd/overview.js` | 页面：运行状态、累计连接数、最近日志、重启按钮、端口/监听地址设置 |
| `usr/share/luci/menu.d/luci-app-vlmcsd.json` | 菜单项（服务 → KMS 激活，order 60） |
| `usr/share/rpcd/acl.d/luci-app-vlmcsd.json` | ACL：`service.list`、`logread`、init 脚本 exec |

状态查询走 procd 的 ubus `service` 对象（`ubus call service list '{"name":"vlmcsd","verbose":true}'`），不额外装 rpcd 模块；改端口/监听地址点「保存并应用」即触发 `reload_config`，靠 init 里的 `procd_add_reload_trigger "vlmcsd"` 用新参数重启，不用重启路由器。

## SFTP 传文件

`openssh-sftp-server` 已编进固件。dropbear 收到 `subsystem sftp` 请求时会 exec `/usr/lib/sftp-server`，装了这个包就直接能用，**不需要装整套 openssh-server，也不用改 dropbear 配置**。

客户端（端口 22、密码就是 root 密码）：

| 客户端 | 地址栏 |
|---|---|
| WinSCP / FileZilla | `sftp://root@172.20.0.1` |
| MobaXterm | 新建 SFTP session → 172.20.0.1 / root |
| Windows 资源管理器 | `\\172.20.0.1` 不行，SFTP 不是 SMB；用 `sftp 172.20.0.1` 或下面的一行命令 |
| 命令行（Windows 自带 OpenSSH） | `sftp root@172.20.0.1`，然后 `put 本地文件 /tmp/` |

Shell 里一行推/拉（Windows 10+ 自带 `scp`，用的是同一套 SSH）：

```powershell
scp .\openwrt-25.12.6-...-sysupgrade.bin root@172.20.0.1:/tmp/
scp root@172.20.0.1:/etc/config/network .
```

注意两点：
- 默认落在 `/root`（overlay），**大文件放 `/tmp`**（内存盘，重启没）。别把固件往 `/root` 里塞，25MB 的 overlay 顶不住。
- `/usr/lib/sftp-server` 只在 overlay 占 113 KB；刷了带这个包的固件后它就在 squashfs 里，不占。

## 界面：中文 + argon 主题

语言固定 `zh_cn`（不依赖浏览器 Accept-Language），主题用 argon（左侧竖排菜单）。整套文件都在 `files/` 里，直接进 squashfs。

**argon 3.x 是「四件套」，只搬一层就会挂，而且编译期看不出来：**

| 层 | 文件 | 缺了会怎样 |
|---|---|---|
| 模板 | `usr/share/ucode/luci/template/themes/argon/*.ut` | 主题不生效，回落默认样式 |
| ucode 模块 | `usr/share/ucode/luci/argon-palette.uc`、`argon-branding.uc` | **整个 web 500**：`Unable to compile head.ut: Unable to resolve path for module 'luci.argon-palette'` |
| 前端 JS | `www/luci-static/resources/menu-argon.js` / `argon-compat.js` / `argon-appearance.js` / `argon-overview.js` / `argon-sshkeys.js` / `argon-graphs.js` | 首页 200 但**左侧菜单整块空白**（菜单是 JS 填进 `#mainmenu` 的，js 404 就永远 `display:none`） |
| rpcd 后端 | `usr/libexec/rpcd/luci.argon*` + `usr/share/rpcd/acl.d/luci-theme-argon.json` | 主题设置页读不到参数 |

这两个坑都是真踩过的。现在 CI 有静态闸：扫所有 `.ut` 里的 `from 'luci.xxx'` 和 `L.require('argon-*' | 'menu-argon')`，对应文件不在 `files/` 里就直接构建失败。

**万一还是开不了页面**（SSH 还能进的情况下），切回官方主题救急：

```sh
uci set luci.main.mediaurlbase='/luci-static/bootstrap'
uci delete luci.themes.Argon
uci commit luci && /etc/init.d/uhttpd restart
```

刷完机 root 是空密码时，`99-newifi-custom` 会自动设成 `password`（已有密码不动），并显式打开 dropbear 的密码认证——否则空密码 + 主题报错会同时堵死 SSH 和 LuCI 两个入口。

## 验证

```sh
ip -4 -o addr show | grep -v 127.0.0.1     # 三个地址对不对
ip route get 10.85.200.99                  # 是否走 wan2
ls /lib/modules/*/ | grep -c mt76          # 应该是 0，wifi 驱动确实没了
logread -e proxy-mipsle | tail             # 代理二进制拉下来没有
netstat -lntp | grep 1688                  # KMS 在听
netstat -lnup | grep :123                  # NTP 服务端在听
tc -s qdisc show dev wan | head -3         # SQM 的 cake 挂上了
ls -l /usr/lib/sftp-server                 # SFTP 子进程在（WinSCP 用得上）
curl -x http://cl:cl@172.20.0.1:1089 -sI https://www.baidu.com | head -1
```

## 目录

```
.github/workflows/build.yml               SDK 工具链编 vlmcsd → ImageBuilder 出固件 → 内容校验
files/etc/uci-defaults/99-newifi-custom   首启一次性配置
files/etc/init.d/vlmcsd                   KMS 服务
files/etc/init.d/proxy-mipsle             代理服务（下载 + 运行合一，二进制不落闪存）
files/usr/share/ucode/luci/*.uc           argon 主题的 ucode 模块（palette / branding）
files/www/luci-static/resources/*.js      argon 主题的前端（菜单渲染、明暗模式、状态页卡片）
files/usr/libexec/rpcd/luci.argon*        argon 主题的 rpcd 后端
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
