# Prerequisites

Four things. Takes about two minutes.

## macOS

The password lives in the macOS Keychain and the installer edits `~/.zshrc`, so this is Mac only. Everything else is portable if you want to port it.

## Node 18 or newer

Check:

```sh
node --version
```

If it is missing, `brew install node`. Built and tested on v22.

## A TeamWork login

Your employee number and password for tmwork.net. The ones you type into the Employee sign-in.

Your employee number is the `EmpUser` field on the sign-in form. Mine is 5 digits.

Also check which location you are under. Mine is `RSO Boston` and the code is `Resident`. If yours differs, the installer asks.

## zsh

Default shell on macOS since Catalina, so you almost certainly have it.

```sh
echo $SHELL
```

If that says bash, the installer still works but you have to add the `rso` function to `~/.bash_profile` yourself. It prints it for you.

## Not needed

Playwright is a dev dependency, only for `recon.mjs` when the site changes and I have to re-capture the API. The app itself has zero runtime dependencies.
