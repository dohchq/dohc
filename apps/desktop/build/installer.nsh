; New per-user installs go to Programs\dohc. electron-builder would name the
; folder after the package, @dohc/desktop, as @dohcdesktop. An existing
; install keeps the folder its registry entry records.
!define /redef APP_FILENAME "dohc"
