"""
EARLCoin KYC Registry

On-chain verification/denylist registry using account local state.

Users opt into this app once. The DAO/admin can then mark that wallet as:
  verified = 1/0
  blocked  = 1/0
  expires  = unix timestamp, or 0 for no expiry

Other contracts, including the in-kind exchange, can read this local state with
App.localGetEx(sender, registry_app_id, key). This is more Web3-native than a
single hardcoded VNFT ASA and supports wallet rotation/recovery by verifying a
new wallet and blocking/revoking an old one.
"""

from pyteal import *

ADMIN_KEY = Bytes("admin")
PAUSED_KEY = Bytes("paused")
VERIFIED_KEY = Bytes("verified")
BLOCKED_KEY = Bytes("blocked")
EXPIRES_KEY = Bytes("expires")
UPDATED_KEY = Bytes("updated")


def approval_program():
    is_admin = Txn.sender() == App.globalGet(ADMIN_KEY)
    method = Txn.application_args[0]
    target = Txn.accounts[1]

    on_create = Seq([
        App.globalPut(ADMIN_KEY, Txn.sender()),
        App.globalPut(PAUSED_KEY, Int(0)),
        Approve(),
    ])

    on_optin = Seq([
        App.localPut(Int(0), VERIFIED_KEY, Int(0)),
        App.localPut(Int(0), BLOCKED_KEY, Int(0)),
        App.localPut(Int(0), EXPIRES_KEY, Int(0)),
        App.localPut(Int(0), UPDATED_KEY, Global.latest_timestamp()),
        Approve(),
    ])

    set_status = Seq([
        Assert(is_admin),
        Assert(Txn.accounts.length() >= Int(1)),
        Assert(Txn.application_args.length() >= Int(4)),
        App.localPut(target, VERIFIED_KEY, Btoi(Txn.application_args[1])),
        App.localPut(target, BLOCKED_KEY, Btoi(Txn.application_args[2])),
        App.localPut(target, EXPIRES_KEY, Btoi(Txn.application_args[3])),
        App.localPut(target, UPDATED_KEY, Global.latest_timestamp()),
        Approve(),
    ])

    verify = Seq([
        Assert(is_admin),
        Assert(Txn.accounts.length() >= Int(1)),
        App.localPut(target, VERIFIED_KEY, Int(1)),
        App.localPut(target, BLOCKED_KEY, Int(0)),
        App.localPut(target, EXPIRES_KEY, Int(0)),
        App.localPut(target, UPDATED_KEY, Global.latest_timestamp()),
        Approve(),
    ])

    block = Seq([
        Assert(is_admin),
        Assert(Txn.accounts.length() >= Int(1)),
        App.localPut(target, BLOCKED_KEY, Int(1)),
        App.localPut(target, UPDATED_KEY, Global.latest_timestamp()),
        Approve(),
    ])

    revoke = Seq([
        Assert(is_admin),
        Assert(Txn.accounts.length() >= Int(1)),
        App.localPut(target, VERIFIED_KEY, Int(0)),
        App.localPut(target, UPDATED_KEY, Global.latest_timestamp()),
        Approve(),
    ])

    transfer_admin = Seq([
        Assert(is_admin),
        Assert(Txn.accounts.length() >= Int(1)),
        App.globalPut(ADMIN_KEY, target),
        Approve(),
    ])

    toggle_pause = Seq([
        Assert(is_admin),
        App.globalPut(PAUSED_KEY, Int(1) - App.globalGet(PAUSED_KEY)),
        Approve(),
    ])

    no_op = Cond(
        [method == Bytes("set_status"), set_status],
        [method == Bytes("verify"), verify],
        [method == Bytes("block"), block],
        [method == Bytes("revoke"), revoke],
        [method == Bytes("transfer_admin"), transfer_admin],
        [method == Bytes("toggle_pause"), toggle_pause],
    )

    return Cond(
        [Txn.application_id() == Int(0), on_create],
        [Txn.on_completion() == OnComplete.OptIn, on_optin],
        [Txn.on_completion() == OnComplete.NoOp, no_op],
        [Txn.on_completion() == OnComplete.UpdateApplication, Seq([Assert(is_admin), Approve()])],
        [Txn.on_completion() == OnComplete.DeleteApplication, Seq([Assert(is_admin), Approve()])],
        [Txn.on_completion() == OnComplete.CloseOut, Approve()],
    )


def clear_state_program():
    return Approve()


if __name__ == "__main__":
    import os

    out_dir = os.path.join(os.path.dirname(__file__), "build")
    os.makedirs(out_dir, exist_ok=True)

    approval_teal = compileTeal(approval_program(), mode=Mode.Application, version=8)
    clear_teal = compileTeal(clear_state_program(), mode=Mode.Application, version=8)

    with open(os.path.join(out_dir, "kyc_registry_approval.teal"), "w") as f:
        f.write(approval_teal)

    with open(os.path.join(out_dir, "kyc_registry_clear.teal"), "w") as f:
        f.write(clear_teal)

    print(f"Compiled to {out_dir}/")
    print(f"Approval: {len(approval_teal)} bytes")
    print(f"Clear: {len(clear_teal)} bytes")
