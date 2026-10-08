# 小太阳工作轨迹

> 记录每一步，让经验有迹可循

一个围绕工作项目、线性流程节点、工作笔记与待办任务组织的本地工作记录网站。

## 当前版本

`v0.1` 本地可用原型：

- 工作台与近期任务
- 项目卡片、搜索和状态筛选
- 创建项目与线性流程节点
- 节点状态管理
- 工作笔记及审核状态
- 节点任务创建与完成状态
- 私有云端文件上传、下载、重命名与删除
- 外部资料链接记录
- 项目结题只读与重新开启
- 浏览器本地存储

## 本地使用

- macOS：双击 `启动小太阳.command`，等待浏览器自动打开。首次使用如果被系统拦截，可在 Finder 中右键文件后选择“打开”。
- Windows：双击 `启动小太阳.cmd`。
- 也可在当前目录运行 `python3 -m http.server 4173`，再访问 `http://127.0.0.1:4173`。

## 公网部署

仓库已包含 GitHub Pages 自动部署流程：

1. 将代码推送到 GitHub 的 `main` 分支。
2. 在仓库 **Settings → Pages** 中，将 **Source** 设为 **GitHub Actions**。
3. 等待 **Actions** 页面中的部署任务完成。
4. 通过 `https://xtyyy-921.github.io/sun-track-work-journal/` 访问网站。

每次推送 `main` 分支后，网站会自动更新。

## Supabase 账号与云端同步

网站已支持 Supabase 邮箱账号、跨设备同步和密码找回。配置步骤：

1. 在 Supabase 创建一个项目。
2. 打开 Supabase Dashboard 的 **SQL Editor**，执行 `supabase/schema.sql`。
3. 在 **Project Settings → API** 中复制 Project URL 和 Publishable key（旧项目中可能显示为 `anon` key）。
4. 将两项公开配置填入 `supabase-config.js`：

```js
window.SUN_TRACK_CONFIG = {
  supabaseUrl: "https://your-project.supabase.co",
  supabasePublishableKey: "your-publishable-key",
};
```

5. 在 **Authentication → URL Configuration** 中，将本地地址和正式网址加入 Redirect URLs：
   - `http://127.0.0.1:4173/**`
   - `https://xtyyy-921.github.io/sun-track-work-journal/**`
6. 重新打开网站即可注册或登录。

`supabasePublishableKey` 是专门供浏览器使用的公开密钥，真正的数据隔离由 `schema.sql` 中的 Row Level Security 规则保证。不得在网页代码中使用 Supabase `service_role` key。

用户首次登录时，如果这台电脑上已有旧的本地数据，系统会自动将它迁移到该账号的云端工作区。之后在新电脑登录同一账号即可读取相同内容。

## 数据说明

完成 Supabase 配置后，业务数据保存在用户私有的云端工作区，并在浏览器 `localStorage` 中保留一份按账号隔离的本地缓存。没有配置 Supabase 时，网站会继续以原有本地模式运行。

当前云端版本已支持账号、数据库同步和 Supabase Storage 私有附件。附件路径按登录用户隔离，单个文件上限为 10 MB；项目公共资料和流程节点均可上传真实文件或添加外部链接。
