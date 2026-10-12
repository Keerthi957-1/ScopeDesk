
ScopeDesk: Secure Task-Bounded Remote Support

ScopeDesk is an open-source, lightweight desktop application designed for small offices to grant secure, time-limited, and task-bounded remote IT support to external vendors. Instead of relying on a complex external server infrastructure, ScopeDesk is a standalone desktop app that establishes a direct, secure connection between a Client and a Vendor.
By enforcing isolation, ScopeDesk restricts remote access strictly to a specific task window and alerts the client instantly if the vendor attempts to break bounds.

🚀 Key Features

• Single App, Dual Roles: Switch between Client Mode and Vendor Mode right from the launch screen.
• Local Authentication: Simple built-in sign-up and login system backed by a local encrypted configuration file.
• Direct Token Handshake: Clients generate a unique, time-bound session token containing their IP address and task details to give to the vendor.
• Task-Bounded Security Window: Restricts the remote viewer focus strictly to the application process designated by the client (e.g., ERP app, billing software, or printer settings).
• Intrusion Alert & Auto-Kill: Real-time process monitoring triggers a warning and instantly drops the network socket connection if the vendor tries to minimize the task window or open unapproved tools.
