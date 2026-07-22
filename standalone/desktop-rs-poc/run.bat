@echo off
rem Launch the Rust desktop POC. See ../../dev-notes/poc-visual-proof.md.
rem Dev profile — instant rebuilds when source changes. For release timings use `cargo run --release`.

cd /d "%~dp0"
cargo run
pause
