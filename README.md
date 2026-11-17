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
| `vlmcsd` | **KMS 激活服务**，监听 `1688`（官方源没有这个包，CI 里用 SDK 的 musl 工具链从源码编，KMS 数据内嵌，不依赖 `/etc/vlmcsd.kmd`） |
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
| SQM 整形 | `wan` 上跑 cake，下行 `10500` / 上行 `3000` kbit/s，进出双向 |
| NTP 服务端 | `enable_server=1`，上游换 `ntp.aliyun.com` / `ntp.tencent.com` / `ntp.ntsc.ac.cn` |
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

## SQM 怎么调

`sqm-scripts` 只是执行器，真正起作用的是 cake 和那两个数字。**数字填错是这套东西唯一会翻车的地方**：

| 填法 | 后果 |
|---|---|
| **大于**真实带宽 | 整形器不触发，等于没开，延迟该炸还是炸 |
| **小于**真实带宽 | 不丢包但峰值被压住，延迟确实变好 |

出厂预设 `download=10500` / `upload=3000`：下行是路由器上实测 `1.51 MB/s ≈ 12 Mbps × 0.9`；上行没实测过（那条线只有 4–12 Mbps 的下行数据），先给保守值。

改起来**不用重编固件**：

1. LuCI → 网络 → SQM QoS，改 Download / Upload，点「应用」；
2. 或者命令行：

```sh
uci set sqm.@queue[0].download='10500'
uci set sqm.@queue[0].upload='3000'
uci commit sqm && /etc/init.d/sqm restart
```

确认真的在整形：

```sh
tc -s qdisc show dev wan        # 有 cake，Sent 字节在涨
tc -s qdisc show dev ifb4wan    # 下行整形跑在 ifb 上
logread -e sqm | tail
```

跑一次测速，看 `tc -s qdisc show dev wan` 里 `Sent` 的增速 ≈ 设定的 upload，说明整形在工作。

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
