const { origin } = require('../../config');
function send(method, opts) {
  return new Promise((resolve, reject) => wx[method]({ ...opts,
    success: r => r.statusCode === 200 ? resolve() : reject(new Error(r.statusCode === 410
      ? '本次导入已过期，请回星引重新选择。' : '上传未完成（' + r.statusCode + '）。')),
    fail: () => reject(new Error('无法连接文件接收服务，请检查网络后重试。')),
  }));
}
Page({
  data: { files: [], enabled: false, busy: false, done: false, error: '' },
  onLoad({ id, ticket }) {
    if (!origin || !/^https:\/\//.test(origin) || !/^[\w-]{32}$/.test(id || '') || !/^[\w-]{32}$/.test(ticket || '')) {
      this.setData({ error: '请从星引讨论里的「微信聊天文件」打开已配置的小程序。' });
      return;
    }
    this.url = origin + '/v1/imports/' + id;
    this.header = { Authorization: 'Bearer ' + ticket };
    this.setData({ enabled: true });
  },
  pick() {
    wx.chooseMessageFile({ count: 3, type: 'all',
      success: ({ tempFiles }) => {
        if (tempFiles.some(f => f.size > 4 * 1024 * 1024)) {
          this.setData({ files: [], error: '单份文件不能超过 4 MiB，请重新选择。' }); return;
        }
        this.setData({ files: tempFiles.map(({ name, size, path }) => ({ name, size, path })), error: '' });
      },
      fail: e => { if (!/cancel/i.test(e.errMsg)) this.setData({ error: '微信没有返回文件，请重新选择。' }); },
    });
  },
  async upload() {
    if (!this.data.files.length || this.data.busy || this.data.done) return;
    this.setData({ busy: true, attempted: true, error: '' });
    try {
      for (let i = this.uploaded || 0; i < this.data.files.length; i++) {
        const f = this.data.files[i];
        await send('uploadFile', { url: this.url + '/files/' + i, header: this.header, filePath: f.path,
          name: 'file', formData: { name: f.name } });
        this.uploaded = i + 1;
      }
      await send('request', { url: this.url + '/finish', header: { ...this.header, 'content-type': 'text/plain' },
        method: 'POST', data: String(this.data.files.length) });
      this.setData({ done: true });
    } catch (e) { this.setData({ error: e.message + ' 若最后一步中断，也可回星引核对。' }); }
    finally { this.setData({ busy: false }); }
  },
  returnError() { this.setData({ error: '请手动切回星引，原讨论会核对本次导入。' }); },
});
