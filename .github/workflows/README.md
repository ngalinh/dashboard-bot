# CI/CD Setup

Workflow `deploy.yml` tự deploy mỗi lần push lên `main`:
1. SSH vào server
2. `git fetch` → `git reset --hard origin/main`
3. `docker compose -f docker-compose.prod.yml up --build -d --remove-orphans`
4. Đợi `/health` trả 200 (tối đa 60s)
5. Dọn image + build cache cũ để không đầy ổ đĩa

Code migration (ALTER TABLE cột mới) chạy tự động trong Platform khi service start — không cần thêm bước.

## Secrets phải tạo trên Github

Vào **Settings → Secrets and variables → Actions → New repository secret**:

| Tên                | Giá trị                                                                                           |
|--------------------|---------------------------------------------------------------------------------------------------|
| `DEPLOY_HOST`      | IP hoặc hostname server (vd `103.200.xx.xx` hoặc `deploy.example.com`)                            |
| `DEPLOY_USER`      | User SSH trên server (vd `deploy`, `ubuntu`). **Không nên là root.**                              |
| `DEPLOY_PORT`      | (Optional) Port SSH nếu khác 22                                                                   |
| `DEPLOY_SSH_KEY`   | Private key (nội dung file `id_ed25519`, **cả 2 dòng `BEGIN/END`**). Xem bước 2 bên dưới.         |
| `DEPLOY_PATH`      | Đường dẫn tuyệt đối tới repo trên server (vd `/home/deploy/dashboard-bot`)                        |
| `PUBLIC_ORIGIN`    | (Optional) URL production để hiển thị trong panel Deployments của Github                          |

## Setup server (1 lần)

### 1) Tạo user deploy không phải root

```bash
# ssh vào server bằng root (lần duy nhất)
adduser deploy
usermod -aG docker deploy    # cho phép deploy chạy docker không cần sudo
mkdir -p /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chown deploy:deploy /home/deploy/.ssh
```

### 2) Tạo SSH key riêng cho CI/CD

Trên **máy local** của bạn (không phải runner):

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/dashboard_bot_deploy -N ""
```

Lệnh này tạo 2 file:
- `~/.ssh/dashboard_bot_deploy`     — **private key** (paste vào secret `DEPLOY_SSH_KEY`)
- `~/.ssh/dashboard_bot_deploy.pub` — public key (copy lên server bước kế tiếp)

### 3) Cài public key lên server cho user `deploy`

```bash
# copy nội dung file .pub lên server, thêm vào authorized_keys của user deploy
ssh root@YOUR_SERVER "cat >> /home/deploy/.ssh/authorized_keys" < ~/.ssh/dashboard_bot_deploy.pub
ssh root@YOUR_SERVER "chmod 600 /home/deploy/.ssh/authorized_keys && chown deploy:deploy /home/deploy/.ssh/authorized_keys"
```

Test: `ssh -i ~/.ssh/dashboard_bot_deploy deploy@YOUR_SERVER "echo OK"` — nếu ra `OK` là đúng.

### 4) Clone repo trên server lần đầu

```bash
ssh deploy@YOUR_SERVER
cd ~
git clone https://github.com/ngalinh/dashboard-bot.git
cd dashboard-bot
# tạo .env (PLATFORM_ADMIN_USER, PLATFORM_ADMIN_PASSWORD, MYSQL_ROOT_PASSWORD, PUBLIC_ORIGIN...)
cp .env.example .env && nano .env
docker compose -f docker-compose.prod.yml up --build -d
```

→ Đường dẫn này (`/home/deploy/dashboard-bot`) chính là giá trị của secret `DEPLOY_PATH`.

### 5) Paste các secret vào Github

Theo bảng ở trên. `DEPLOY_SSH_KEY` paste **nguyên nội dung** file `~/.ssh/dashboard_bot_deploy` (bao gồm `-----BEGIN OPENSSH PRIVATE KEY-----` và `-----END OPENSSH PRIVATE KEY-----`).

## Test lần đầu

Vào **Actions** tab trên Github → chọn workflow `Deploy to server` → **Run workflow** (nhánh `main`) → xem log.

Hoặc đẩy 1 commit trivial lên `main` để trigger:

```bash
git commit --allow-empty -m "chore: trigger deploy"
git push
```

## Rollback

Nếu deploy lỗi cần revert về commit cũ:

```bash
# trên máy local
git revert HEAD
git push          # workflow tự chạy, deploy revert commit
```

Hoặc SSH trực tiếp vào server:

```bash
ssh deploy@YOUR_SERVER
cd /home/deploy/dashboard-bot
git reset --hard <commit_cu>
docker compose -f docker-compose.prod.yml up --build -d
```

## Các secret KHÔNG nên commit vào repo

- `.env` (có `PLATFORM_ADMIN_PASSWORD`, `MYSQL_ROOT_PASSWORD`, `PLATFORM_SESSION_SECRET`…) — file này nằm ở server, **không** push lên Github
- SSH private key — chỉ ở Github Secrets + máy local bạn, **không** commit vào repo
- Nếu lỡ commit file nhạy cảm → rotate ngay (đổi password, revoke key) rồi dùng `git filter-repo` / BFG để xoá lịch sử
