'use strict';
'require view';
'require form';
'require fs';
'require rpc';
'require uci';
'require ui';

/*
 * KMS 激活（vlmcsd）管理页
 *
 * 状态查询走 ubus 的 service 对象（procd 提供，不用额外 rpcd 模块），
 * 日志走 logread，重启走 init 脚本。三个动作的 ACL 写在
 * /usr/share/rpcd/acl.d/luci-app-vlmcsd.json。
 */

var callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: [ 'name', 'verbose' ],
	expect: { }
});

function row(label, value) {
	return E('div', { 'class': 'tr' }, [
		E('div', { 'class': 'td left', 'style': 'width:32%' }, label),
		E('div', { 'class': 'td left' }, value)
	]);
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('vlmcsd'),
			callServiceList('vlmcsd', true).then(function(res) {
				var insts = (res && res.vlmcsd && res.vlmcsd.instances) || { };
				return Object.keys(insts).some(function(k) { return insts[k].running; });
			}).catch(function() { return false; }),
			fs.exec('/sbin/logread', [ '-e', 'vlmcsd' ])
				.then(function(res) { return (res.stdout || '').trim(); })
				.catch(function() { return ''; })
		]);
	},

	handleRestart: function() {
		return fs.exec('/etc/init.d/vlmcsd', [ 'restart' ]).then(function() {
			ui.addNotification(null, E('p', {}, _('已重启 KMS 服务，1 秒后刷新状态…')), 'info');
			window.setTimeout(function() { location.reload(); }, 1200);
		}).catch(function(err) {
			ui.addNotification(null, E('p', {}, _('重启失败：') + err), 'danger');
		});
	},

	handleReload: function() {
		return location.reload();
	},

	renderStatus: function(running, log) {
		var lines = (log || '').split('\n').filter(function(l) { return l.length; });
		var accepted = 0;
		lines.forEach(function(l) {
			if (l.indexOf('connection accepted') > -1)
				accepted++;
		});

		var port = uci.get('vlmcsd', 'main', 'port') || '1688';
		var listen = uci.get('vlmcsd', 'main', 'listen') || '0.0.0.0';
		var tail = lines.length
			? lines.slice(-12).join('\n')
			: _('（服务运行后还没有收到任何激活请求）');

		return E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('运行状态')),
			E('div', { 'class': 'table', 'style': 'width:100%' }, [
				row(_('状态'), running
					? E('strong', { 'style': 'color:#d33' }, _('运行中'))
					: E('strong', { 'style': 'color:#888' }, _('已停止'))),
				row(_('监听地址'), '%s:%s'.format(listen, port)),
				row(_('累计连接数'), String(accepted)),
				row(_('客户端配置'), E('code', {}, 'slmgr /skms %s:%s'.format(
					listen === '0.0.0.0' ? '172.20.0.1' : listen, port))),
				row(_('进程'), running ? 'vlmcsd' : _('未运行'))
			]),
			E('div', { 'class': 'cbi-page-actions', 'style': 'display:flex;gap:8px;justify-content:flex-start;padding-left:0' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, 'handleRestart')
				}, _('重启服务')),
				E('button', {
					'class': 'btn cbi-button',
					'click': ui.createHandlerFn(this, 'handleReload')
				}, _('刷新状态'))
			]),
			E('h4', {}, _('最近日志')),
			E('pre', {
				'style': 'max-height:220px;overflow:auto;font-size:12px;line-height:1.45;' +
					'background:rgba(127,127,127,.08);padding:8px;border-radius:4px;margin:0'
			}, tail)
		]);
	},

	render: function(data) {
		var m = new form.Map('vlmcsd', _('KMS 激活服务'),
			_('vLMCSD 服务器，供 Windows 与 Office 走 KMS 激活。默认不校验来源，' +
			  '任何能连到这个端口的机器都会被应答。'));

		var s = m.section(form.NamedSection, 'main', 'vlmcsd', _('服务设置'));
		s.anonymous = true;

		var o = s.option(form.Flag, 'enabled', _('启用服务'),
			_('关掉后进程立即停止，开机也不会启动'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Value, 'port', _('监听端口'),
			_('客户端用 <code>slmgr /skms 地址:端口</code> 指定；改完保存即生效'));
		o.datatype = 'range(1,65535)';
		o.placeholder = '1688';
		o.default = '1688';
		o.rmempty = false;

		o = s.option(form.Value, 'listen', _('监听地址'),
			_('0.0.0.0 = 所有网卡，办公网那侧也能连；只填 172.20.0.1 则仅 LAN 可访问'));
		o.datatype = 'ipaddr';
		o.placeholder = '0.0.0.0';
		o.default = '0.0.0.0';
		o.rmempty = false;

		var status = this.renderStatus(data[1], data[2]);
		var formnode = m.render();

		// form.Map.render() 在不同 25.x 小版本里可能返回 Node 或 Promise，两种都兜住
		if (formnode && typeof formnode.then === 'function')
			return formnode.then(function(node) {
				return E('div', { }, [ status, node ]);
			});

		return E('div', { }, [ status, formnode ]);
	}
});
