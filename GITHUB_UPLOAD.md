# 将 Lava_test 项目上传到 GitHub

项目目录：`D:\Code_project\Lava_test`。系统代理：`127.0.0.1:7897`。

## 配置 Git 代理

```powershell
git config --global http.proxy  http://127.0.0.1:7897
git config --global https.proxy http://127.0.0.1:7897
```

检查代理连通性：

```powershell
Test-NetConnection 127.0.0.1 -Port 7897
```

## 提交并推送当前项目

```powershell
Set-Location 'D:\Code_project\Lava_test'
git status
git add -A
git commit -m "更新项目并补充作品展示"
git push -u origin main
```

本项目已有 `origin` 远程仓库。如果当前分支不是 `main`，请将推送命令中的分支名替换为实际分支名。

## 远程仓库有新提交时

```powershell
git pull --rebase origin main
git push -u origin main
```

出现冲突时，解决文件后执行 `git add <文件>`、`git rebase --continue`，再重新推送。

## GitHub 登录

HTTPS 推送需要 GitHub Personal Access Token（PAT），不能使用账户密码。不要把 Token 写入脚本或提交记录。也可以切换到 SSH：

```powershell
git remote set-url origin git@github.com:<用户名>/<仓库名>.git
git push -u origin main
```

## 完成后验证

```powershell
git status
git log -1 --oneline
git remote -v
```

如需取消全局代理：

```powershell
git config --global --unset http.proxy
git config --global --unset https.proxy
```
