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

| Tên                | Giá trị                                                         |
|--------------------|-----------------------------------------------------------------|
| `DEPLOY_HOST`      | IP hoặc hostname server                                         |
| `DEPLOY_USER`      | User SSH trên server (vd `vmadmin`, `deploy`, `ubuntu`)         |
| `DEPLOY_PORT`      | (Optional) Port SSH nếu khác 22                                 |
| `DEPLOY_SSH_KEY`   | Private key (nội dung file `id_ed25519`, cả 2 dòng BEGIN/END)   |
| `DEPLOY_PATH`      | Đường dẫn tuyệt đối tới repo trên server (vd `/opt/dashboard-bot`) |
| `PUBLIC_ORIGIN`    | (Optional) URL production hiện trong panel Deployments          |

## Setup server (1 lần)

### 1) Tạo SSH key pair riêng cho CI/CD (trên máy local)

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/dashboard_bot_deploy -N ""
```

- `~/.ssh/dashboard_bot_deploy`     → paste nội dung vào secret `DEPLOY_SSH_KEY`
- `~/.ssh/dashboard_bot_deploy.pub` → cài lên server (bước 2)

### 2) Setup server

SSH vào server với quyền sudo (user hiện có, vd `vmadmin` hoặc `ubuntu`). Chạy script:

```bash
# Cài Docker (nếu chưa)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # user hiện tại dùng docker không cần sudo (logout/in lại để active)

# Add deploy public key vào authorized_keys của user hiện tại
# (thay YOUR_PUBKEY bằng nội dung file .pub tạo ở bước 1)
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo 'YOUR_PUBKEY_LINE_HERE' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# Clone repo tại /opt/dashboard-bot
sudo mkdir -p /opt
sudo git clone https://github.com/ngalinh/dashboard-bot.git /opt/dashboard-bot
sudo chown -R $USER:$USER /opt/dashboard-bot

# Tạo .env (sửa PUBLIC_ORIGIN + các password)
cd /opt/dashboard-bot
nano .env     # hoặc: cp .env.example .env rồi sửa

# Deploy lần đầu
docker compose -f docker-compose.prod.yml up --build -d
```

### 3) Paste secrets vào Github

Theo bảng ở đầu file. `DEPLOY_SSH_KEY` paste **nguyên nội dung** file `~/.ssh/dashboard_bot_deploy` (bao gồm 2 dòng `-----BEGIN/END OPENSSH PRIVATE KEY-----`).

## Test lần đầu

**Actions** tab → chọn workflow `Deploy to server` → **Run workflow** (nhánh `main`) → xem log.

Hoặc đẩy 1 commit trivial lên `main` để trigger:

```bash
git commit --allow-empty -m "chore: trigger deploy"
git push
```

## Rollback

```bash
# Trên máy local
git revert HEAD
git push          # workflow tự chạy deploy revert commit
```

Hoặc SSH trực tiếp vào server:

```bash
cd /opt/dashboard-bot
git reset --hard <commit_cu>
docker compose -f docker-compose.prod.yml up --build -d
```

## Troubleshooting — MySQL không lên, log spam `[MY-012595]`

Triệu chứng (xem bằng `docker compose -f docker-compose.prod.yml logs --tail=200 mysql`):

```
[ERROR] [MY-012595] [InnoDB] The error means mysqld does not have the access rights to the directory.
[ERROR] [MY-012592] [InnoDB] Operating system error number 13 in a file operation.
[ERROR] [MY-012894] [InnoDB] Unable to open './#innodb_redo/#ib_redoN' (error: 1000).
```

**Nguyên nhân**: image `mysql:8.4` chạy mysqld dưới user `mysql` UID/GID **999:999** bên trong container. Volume `./data/mysql:/var/lib/mysql` là bind-mount, nên file trên host **phải** thuộc owner `999:999` — nếu lệch (chown nhầm, restore từ backup khác user, đổi userns-remap…) container sẽ không ghi được redo log → crash loop.

**Fix nhanh** (trên server, ở `/opt/dashboard-bot`):

```bash
sudo ./scripts/recover-mysql.sh
```

Script sẽ stop container → `chown -R 999:999 ./data/mysql` → start lại → in log + `ps` để verify. Nếu vẫn lặp lỗi (redo log đã hỏng):

```bash
sudo ./scripts/recover-mysql.sh --reset-redo
```

Phiên bản này tự backup `data/mysql` ra `~/mysql-backup-*.tar.gz` rồi move toàn bộ `#innodb_redo/*` ra `./data/mysql_redo_quarantine_*` cho MySQL tự tạo lại từ đầu (crash recovery dùng `ibdata1` + binlog).

### Khôi phục bảng đã DROP nhầm từ file backup

Sau crash, đôi khi cần `DROP TABLE` để dọn orphan tablespace (`Got error 168 - 'Unknown (generic) error from engine'`). Việc này **xoá data**. Nếu trước đó có chạy `recover-mysql.sh --reset-redo` thì đã có file `~/mysql-backup-*.tar.gz` — dùng script sau để recover từng bảng:

```bash
sudo ./scripts/restore-tables-from-backup.sh \
     ~/mysql-backup-2026-04-28-0839.tar.gz \
     basso_platform \
     user_sessions daily_order_stats app_config \
     --bot=bot-794e5c0b078fc669
```

Script tự dựng MySQL phụ từ backup → `mysqldump` các bảng cần lấy → DROP bảng cũ trong MySQL chính → import dump → restart bot. Bot/Platform vẫn chạy, chỉ bot được nêu sẽ stop trong lúc import (~10s).

## Log bot có timestamp

Từ commit này trở đi, mọi process PM2 spawn cho bot Node/Python đều dùng flag `--time` nên mỗi dòng log có prefix `YYYY-MM-DD HH:mm:ss`. Hiệu lực với bot **mới** hoặc bot bị `pm2 delete` rồi start lại — bot cũ đang chạy cần restart bằng cách: edit/redeploy bot trong dashboard, hoặc trên server:

```bash
docker compose -f docker-compose.prod.yml exec platform pm2 delete bot-<id>
# rồi vào dashboard bấm Start lại bot đó
```

## KHÔNG commit các file nhạy cảm

- `.env` (có `PLATFORM_ADMIN_PASSWORD`, `MYSQL_ROOT_PASSWORD`, `PLATFORM_SESSION_SECRET`…) — nằm ở server, không push Github
- SSH private key — chỉ ở Github Secrets + máy local, không commit
- Nếu lỡ commit → rotate ngay (đổi password, revoke key) rồi xoá lịch sử bằng `git filter-repo` / BFG
