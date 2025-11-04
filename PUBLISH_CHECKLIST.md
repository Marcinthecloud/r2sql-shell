# Publishing Checklist for r2sql

Follow these steps to publish r2sql to Homebrew.

## Pre-publishing

- [ ] Update version in `package.json` if needed
- [ ] Run `npm run build` to ensure code compiles
- [ ] Test the CLI locally: `npm start -- --help`

## Step 1: Build Executables

```bash
cd /Users/mselwan/Documents/r2sql-shell
npm run package:all
```

- [ ] Verify `bin/r2sql-shell-macos` exists
- [ ] Verify `bin/r2sql-shell-linux` exists
- [ ] Verify `bin/r2sql-shell-win.exe` exists

## Step 2: Test macOS Binary

```bash
chmod +x bin/r2sql-shell-macos
./bin/r2sql-shell-macos --version
./bin/r2sql-shell-macos --help
```

- [ ] Version displays correctly
- [ ] Help displays correctly

## Step 3: Calculate SHA256 Hash

```bash
shasum -a 256 bin/r2sql-shell-macos
```

- [ ] Copy and save this hash - you'll need it later!

**Your SHA256 hash:**
```
_______________________________________________________________
```

## Step 4: Create GitHub Repository

1. Go to: https://github.com/new
2. Repository name: `r2sql`
3. Description: `Interactive shell for querying R2 Data Catalog with R2 SQL`
4. Public repository
5. Do NOT initialize with README

- [ ] Repository created

**Your repository URL:**
```
https://github.com/_____________/r2sql
```

## Step 5: Push Code to GitHub

```bash
cd /Users/mselwan/Documents/r2sql-shell

# If not already initialized
git init
git add .
git commit -m "Initial release: R2 SQL Shell v1.0.0"

# Replace YOUR_USERNAME with your GitHub username
git remote add origin https://github.com/YOUR_USERNAME/r2sql.git
git branch -M main
git push -u origin main
```

- [ ] Code pushed to GitHub
- [ ] Verify code is visible on GitHub

## Step 6: Create GitHub Release

1. Go to: `https://github.com/YOUR_USERNAME/r2sql/releases/new`
2. Tag version: `v1.0.0`
3. Release title: `v1.0.0 - Initial Release`
4. Upload these files as release assets:
   - `bin/r2sql-shell-macos` → rename to `r2sql-macos`
   - `bin/r2sql-shell-linux` → rename to `r2sql-linux`
   - `bin/r2sql-shell-win.exe` → rename to `r2sql-win.exe`
5. Click "Publish release"

- [ ] Release created
- [ ] Assets uploaded and renamed correctly

**Your release URL:**
```
https://github.com/_____________/r2sql/releases/tag/v1.0.0
```

## Step 7: Create Homebrew Tap Repository

1. Go to: https://github.com/new
2. Repository name: `homebrew-r2sql`
3. Description: `Homebrew tap for r2sql`
4. Public repository
5. Initialize with README

- [ ] Tap repository created

**Your tap URL:**
```
https://github.com/_____________/homebrew-r2sql
```

## Step 8: Create Homebrew Formula

```bash
cd ~/
git clone https://github.com/YOUR_USERNAME/homebrew-r2sql.git
cd homebrew-r2sql
mkdir -p Formula
```

Create `Formula/r2sql.rb` with this content (use the template from `homebrew-formula-template.rb`):

```ruby
class R2sql < Formula
  desc "Interactive shell for querying R2 Data Catalog with R2 SQL"
  homepage "https://github.com/YOUR_USERNAME/r2sql"
  url "https://github.com/YOUR_USERNAME/r2sql/releases/download/v1.0.0/r2sql-macos"
  sha256 "PASTE_YOUR_SHA256_FROM_STEP_3"
  version "1.0.0"
  license "MIT"

  def install
    bin.install "r2sql-macos" => "r2sql"
  end

  test do
    assert_match "1.0.0", shell_output("#{bin}/r2sql --version")
  end
end
```

**Important replacements:**
- Replace `YOUR_USERNAME` with your GitHub username (2 places)
- Replace `PASTE_YOUR_SHA256_FROM_STEP_3` with the hash from Step 3

```bash
# Commit and push
git add Formula/r2sql.rb
git commit -m "Add r2sql formula v1.0.0"
git push origin main
```

- [ ] Formula file created and pushed

## Step 9: Test Installation

```bash
# Add your tap
brew tap YOUR_USERNAME/r2sql

# Install
brew install r2sql

# Test
r2sql --version
r2sql --help
```

- [ ] Tap added successfully
- [ ] Package installed successfully
- [ ] `r2sql --version` works
- [ ] `r2sql --help` works

## Step 10: Update README

Update the README.md in your main repository to replace `YOUR_USERNAME` with your actual GitHub username:

```bash
cd /Users/mselwan/Documents/r2sql-shell
# Edit README.md and replace YOUR_USERNAME
git add README.md
git commit -m "Update README with actual GitHub username"
git push origin main
```

- [ ] README updated with correct installation instructions

## 🎉 Done!

Users can now install with:

```bash
brew tap YOUR_USERNAME/r2sql
brew install r2sql
```

## For Future Releases

When releasing v1.1.0, v1.2.0, etc.:

1. Update version in `package.json`
2. Run `npm run package:all`
3. Calculate new SHA256: `shasum -a 256 bin/r2sql-shell-macos`
4. Create new GitHub release with new tag and binaries
5. Update `Formula/r2sql.rb` with new version, URL, and SHA256
6. Commit and push the formula update

Users will update with:
```bash
brew update
brew upgrade r2sql
```

## Troubleshooting

**"SHA256 mismatch"**
- Recalculate the hash of your binary
- Make sure you're using the exact file from the release

**"Cannot download"**
- Verify the release URL is correct
- Make sure binaries were uploaded as release assets

**Need help?**
See [HOMEBREW_SETUP.md](HOMEBREW_SETUP.md) for detailed instructions.
