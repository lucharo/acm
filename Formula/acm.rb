# Homebrew formula for the standalone `acm` binary. The repository is its own
# tap. Homebrew 6 and later load no third-party tap they have not been told to
# trust, hence the first line:
#   brew trust --tap lucharo/acm
#   brew tap lucharo/acm https://github.com/lucharo/acm.git
#   brew install lucharo/acm/acm
# The formula installs only the binary; the acm-review skill comes from
# install.sh or `npx skills add lucharo/acm`. The release workflow rewrites the
# release tag and each sha256 below on every release
# (scripts/update-formula.ts), so do not edit them by hand.
class Acm < Formula
  desc "Local editor for human and AI review of a CriticMarkup Markdown file"
  homepage "https://acm.luischav.es"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  on_macos do
    on_arm do
      url "https://github.com/lucharo/acm/releases/download/v0.2.0/acm-darwin-arm64"
      sha256 "98e4fada1af7830878a6bfcf1054cb886e9af1d5fef142ad4128266cc97a348a"
    end
    on_intel do
      url "https://github.com/lucharo/acm/releases/download/v0.2.0/acm-darwin-x64"
      sha256 "d9227ba0d45ecbe6f8fc7790302d0b9cf7e446bc35a9ca3fddd49fc0437f289e"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/lucharo/acm/releases/download/v0.2.0/acm-linux-x64"
      sha256 "23651578a7a48b2b64f0c4935e6988aea077265735b99a9649733bbc549b98a8"
    end
  end

  def install
    bin.install Dir["acm-*"].first => "acm"
  end

  test do
    assert_match "acm", shell_output("#{bin}/acm --help")
  end
end
