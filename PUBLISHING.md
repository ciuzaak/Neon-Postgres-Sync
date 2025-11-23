# Publishing to OpenVSX

This guide explains how to publish the `neon-postgres-sync` extension to the Open VSX Registry.

## Prerequisites

1.  **Open VSX Account**:
    -   Go to [https://open-vsx.org/](https://open-vsx.org/) and sign in (e.g., with GitHub).
    -   Go to **Settings** -> **Access Tokens** and generate a new token. **Save this token securely.**

2.  **Namespace**:
    -   Ensure you have created the namespace `ciuzaak` (or whatever matches your `publisher` in `package.json`) in the Open VSX settings.
    -   If the namespace is already taken by you, great. If not, you might need to change the `publisher` field in `package.json`.

3.  **Install `ovsx` CLI**:
    ```bash
    npm install -g ovsx
    ```

## Publishing Steps

1.  **Package the Extension**:
    This creates a `.vsix` file.
    ```bash
    npx vsce package
    ```
    *(Note: You might need to install `vsce` first: `npm install -g @vscode/vsce`)*

2.  **Publish**:
    Run the publish command using your access token.
    ```bash
    npx ovsx publish -p <YOUR_ACCESS_TOKEN>
    ```
    Or if you have the `.vsix` file generated:
    ```bash
    npx ovsx publish neon-postgres-sync-0.0.1.vsix -p <YOUR_ACCESS_TOKEN>
    ```

## Verification

After publishing, visit `https://open-vsx.org/extension/ciuzaak/neon-postgres-sync` to see your extension live.
