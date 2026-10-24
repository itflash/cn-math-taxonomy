# Android app（Capacitor）

把网页打包成 APK。页面和题库打进安装包（离线可用），孩子档案和诊断记录走服务器的 `/api`。

## 一条命令打包

```bash
cd mobile
CNM_API_BASE=https://你的域名 node build-www.mjs     # 生成 www/，并把服务器地址写进去
npx cap sync android
cd android && ./gradlew assembleDebug                # 产物：app/build/outputs/apk/debug/app-debug.apk
```

正式发布用 `./gradlew assembleRelease`，需要先在 `android/app/build.gradle` 里配签名（见下）。

`CNM_API_BASE` 必须写完整地址（带 https）。APK 里的页面来源是 `https://localhost`，和服务器不同源，
所以后端要放行这个来源：`deploy/.env` 的 `CORS_ORIGINS` 默认已经包含 `https://localhost`。

## 环境要求

- JDK 17+（Android Studio 自带的 `/Applications/Android Studio.app/Contents/jbr/Contents/Home` 就行）
- Android SDK，并在 `android/local.properties` 写 `sdk.dir=/path/to/sdk`
- Node 20+

本机这些已经在用：

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
```

## 和网页版的差别

`build-www.mjs` 会把仓库里的页面复制到 `www/`，同时做三件事：

1. **去掉 `pwa.js` / `pwa.css`**：「添加到桌面」在 app 里没有意义；service worker 还会让 app
   升级后继续用旧的 JS。
2. **写入服务器地址**：生成 `www/assets/sync-config.js`，内容来自 `CNM_API_BASE`。
3. **不拷生成中间产物**：`data/_qbatches`、`screenshots`、`docs`、`scripts` 都不进包。

链接都写成显式的 `index.html`（`explore/index.html` 而不是 `explore/`）。Capacitor 的本地资源
服务器不做目录索引，目录形式的 URL 会回落到根 `index.html`，页面会变成首页。

## 已知的坑

- **debug 才能连明文 HTTP**：`android/app/src/debug/AndroidManifest.xml` 只在 debug 构建里打开
  `usesCleartextTraffic`，方便连本机的测试服务器。release 构建默认只允许 HTTPS，线上必须配好证书。
- **模拟器连宿主机**用 `10.0.2.2`，不是 `localhost`。
- **gradle 仓库**：`android/build.gradle` 里把阿里云镜像插到了 `google()` 前面，因为国内网络直连
  `dl.google.com` 会握手失败。`capacitor-android` 模块自己写的 `google()` 在 `node_modules` 里，
  所以是在根 `build.gradle` 的 `allprojects.buildscript` 里补的镜像。
- `npx cap sync` 会重新生成 `android/` 里的一部分文件，但不会覆盖 `build.gradle` 的手工改动。

## 验证过的

在 Android 模拟器（Pixel 尺寸，Android 15）上跑通过：

- 首页、知识图谱、诊断、档案、账号页都能从 APK 内加载，样式完整，底部标签栏可用
- 打开 app 先要求登录，登录后回到首页
- 页面和题库从本地包读取，不联网也能出题
- app 内登录家庭账号 → 拉到服务器上已有的孩子档案 → 做完一轮诊断 → 记录存进档案并同步到服务器
- 控制台无报错

## 还没做

- 正式签名和 release 构建（需要先定包名和签名密钥）
- 应用图标和启动图（现在还是 Capacitor 的默认图标）
- 服务器地址还没定，所以没有可用的正式 APK；定了域名后按上面的命令重新打包即可
