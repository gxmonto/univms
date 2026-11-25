# Dev build on this PC: GNU Rust target with the portable MinGW from tauri-build-probe (same as RustSIP).
. (Join-Path $env:LOCALAPPDATA 'tauri-build-probe\winlibs-env.ps1')
Set-Location $PSScriptRoot
cargo @args
