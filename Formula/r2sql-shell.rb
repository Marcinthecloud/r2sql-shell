class R2sqlShell < Formula
  desc "Interactive shell for querying R2 Data Catalog with R2 SQL"
  homepage "https://github.com/marcinthecloud/r2sql-shell"
  url "https://github.com/marcinthecloud/r2sql-shell/releases/download/1.1.0/r2sql-shell-macos"
  sha256 "edac479a3acce97ac9045ee3830d77c553d567c0c04577d209d18392a8ae773a"  # Run: shasum -a 256 bin/r2sql-shell-macos
  version "1.1.0"
  license "MIT"

  def install
    # Install the binary as "r2sql-shell" command
    bin.install "r2sql-shell-macos" => "r2sql-shell"
  end

  test do
    # Test that the binary runs and returns correct version
    assert_match "1.1.0", shell_output("#{bin}/r2sql-shell --version")

    # Test that help works
    assert_match "Interactive shell", shell_output("#{bin}/r2sql-shell --help")
  end
end
