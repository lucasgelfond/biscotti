import Foundation

/// Ready-to-paste prompts for a browser agent (e.g. Claude for Chrome) that get a service's keys or launch the cloud
/// machine. The install site uses the same wording.
enum Prompts {
    /// Where each service's keys come from.
    static let sites = [
        "photon": "https://photon.codes",
        "exa": "https://dashboard.exa.ai",
        "google": "https://console.cloud.google.com",
        "github": "https://github.com/settings/personal-access-tokens/new",
        "aws": "https://console.aws.amazon.com/iam/home#/users",
    ]

    static let redirectPlaceholder = """
        https://biscotti.<tailnet>.ts.net:9443/oauth/callback, where <tailnet> is my tailnet name from the Tailscale \
        admin console under DNS (https://login.tailscale.com/admin/dns). If I don't know it yet, skip it: biscotti \
        texts me the exact address when I first connect Google.
        """

    /// A service's prompt, with Google's redirect URI filled in once the tailnet is known.
    static func prompt(_ id: String, redirect: String?) -> String {
        let text = prompts[id] ?? ""
        return redirect.map { text.replacingOccurrences(of: redirectPlaceholder, with: "\($0).") } ?? text
    }

    static let prompts = [
        "photon": """
            Get me Photon Spectrum keys for my biscotti assistant. Stop and let me sign in whenever a login is needed, \
            and don't change anything else.
            1. Go to https://photon.codes and wait for me to sign up or sign in.
            2. Create a Spectrum project named "biscotti" with iMessage turned on.
            3. Show me the project ID and project secret so I can copy them.
            """,
        "exa": """
            Get me an Exa API key. Stop and let me sign in whenever a login is needed, and don't change anything else.
            1. Go to https://dashboard.exa.ai and wait for me to sign in.
            2. Open API Keys and create a new key named "biscotti".
            3. Show me the key so I can copy it.
            """,
        "google": """
            Set up a Google OAuth client for my biscotti assistant. Stop and let me sign in whenever a login is needed, \
            and don't change anything else.
            1. Go to https://console.cloud.google.com and create a project named "biscotti" (or use one I point you to).
            2. Enable the Gmail API and the Google Calendar API for that project.
            3. Configure the OAuth consent screen: External, in testing, with my own email as a test user, and the \
            scopes https://www.googleapis.com/auth/gmail.modify and https://www.googleapis.com/auth/calendar.events.
            4. Create an OAuth client ID of type "Web application" with the authorized redirect URI \
            \(redirectPlaceholder)
            5. Show me the client ID and client secret so I can copy them.
            """,
        "github": """
            Make me a GitHub fine-grained personal access token for my biscotti assistant. Stop and let me sign in \
            whenever a login is needed, and don't change anything else.
            1. Go to https://github.com/settings/personal-access-tokens/new.
            2. Name it "biscotti" and ask me which repositories it should reach.
            3. Repository permissions: Contents, Issues and Pull requests read and write; Metadata read-only.
            4. Generate the token and show it to me so I can copy it.
            """,
        "aws": """
            Make me an AWS access key for my biscotti installer. Stop and let me sign in whenever a login is needed, \
            and don't change anything else.
            1. Go to https://console.aws.amazon.com/iam/home#/users.
            2. Create user "biscotti-installer", with no console access.
            3. Attach policies directly: AmazonEC2FullAccess. Create the user.
            4. Open the user → Security credentials → Create access key → "Application running outside AWS".
            5. Show me the Access key ID and Secret access key (shown only once) so I can copy them into the installer.
            """,
    ]
}
