"""
In-Kind Exchange Smart Contract — EARLCoin (DODO PMM pricing)

Trustlessly exchanges Lofty property tokens for EARL at the live LP market price.
Computes the DODO PMM price on-chain from each property's LP pool state.

DODO PMM sell-base formula:
  P = i × (1 - k + k × (B0/B)²)
  Where:
    i  = oracle_price (reference price from admin app)
    k  = slippage coefficient (from admin app)
    B0 = target_base_balance (from LP interface app)
    B  = base_balance (from LP interface app)

EARL amount = lofty_tokens × P_pmm / earl_price

Box storage: ASA ID (8 bytes) → admin_app_id (8 bytes) + lp_interface_app_id (8 bytes)
"""

from pyteal import *

ADMIN_KEY = Bytes("admin")
EARL_ASA_KEY = Bytes("earl_asa")
KYC_REGISTRY_APP_KEY = Bytes("kyc_registry_app")
EARL_PRICE_KEY = Bytes("earl_price")
PAUSED_KEY = Bytes("paused")
NUM_ACCEPTED_KEY = Bytes("num_accepted")

# Scratch space
EARL_AMOUNT = ScratchVar(TealType.uint64)
PMM_PRICE = ScratchVar(TealType.uint64)
LOFTY_AMOUNT = ScratchVar(TealType.uint64)
K_VAL = ScratchVar(TealType.uint64)
ORACLE_I = ScratchVar(TealType.uint64)
BASE_BAL = ScratchVar(TealType.uint64)
TARGET_BASE = ScratchVar(TealType.uint64)

# Precision constant: k is stored as integer where 100000 = 0.1 (10%)
# We use 1000000 as the k denominator (k=100000 means 10%)
K_DENOM = Int(1000000)


def approval_program():
    is_admin = Txn.sender() == App.globalGet(ADMIN_KEY)
    earl_asa = App.globalGet(EARL_ASA_KEY)
    kyc_registry_app = App.globalGet(KYC_REGISTRY_APP_KEY)
    earl_price = App.globalGet(EARL_PRICE_KEY)
    paused = App.globalGet(PAUSED_KEY)

    registry_verified = App.localGetEx(Txn.sender(), kyc_registry_app, Bytes("verified"))
    registry_blocked = App.localGetEx(Txn.sender(), kyc_registry_app, Bytes("blocked"))
    registry_expires = App.localGetEx(Txn.sender(), kyc_registry_app, Bytes("expires"))

    def check_kyc_registry():
        return Seq([
            Assert(kyc_registry_app > Int(0)),
            # Foreign apps order for exchange is [admin_app, lp_interface_app, kyc_registry_app].
            Assert(Txn.applications.length() >= Int(3)),
            Assert(Txn.applications[3] == kyc_registry_app),
            registry_verified,
            registry_blocked,
            registry_expires,
            Assert(registry_verified.hasValue()),
            Assert(registry_blocked.hasValue()),
            Assert(registry_expires.hasValue()),
            Assert(registry_verified.value() == Int(1)),
            Assert(registry_blocked.value() == Int(0)),
            Assert(Or(registry_expires.value() == Int(0), registry_expires.value() > Global.latest_timestamp())),
        ])

    on_create = Seq([
        App.globalPut(ADMIN_KEY, Txn.sender()),
        App.globalPut(PAUSED_KEY, Int(0)),
        App.globalPut(NUM_ACCEPTED_KEY, Int(0)),
        Approve(),
    ])

    setup = Seq([
        Assert(is_admin),
        Assert(Btoi(Txn.application_args[2]) > Int(0)),
        App.globalPut(EARL_ASA_KEY, Btoi(Txn.application_args[1])),
        App.globalPut(KYC_REGISTRY_APP_KEY, Btoi(Txn.application_args[2])),
        App.globalPut(EARL_PRICE_KEY, Btoi(Txn.application_args[3])),
        Approve(),
    ])

    update_price = Seq([
        Assert(is_admin),
        Assert(Btoi(Txn.application_args[1]) > Int(0)),
        App.globalPut(EARL_PRICE_KEY, Btoi(Txn.application_args[1])),
        Approve(),
    ])

    update_registry = Seq([
        Assert(is_admin),
        Assert(Btoi(Txn.application_args[1]) > Int(0)),
        App.globalPut(KYC_REGISTRY_APP_KEY, Btoi(Txn.application_args[1])),
        Approve(),
    ])

    toggle_pause = Seq([
        Assert(is_admin),
        App.globalPut(PAUSED_KEY, Int(1) - paused),
        Approve(),
    ])

    # Args: [method, asa_id, admin_app_id, lp_interface_app_id]
    # Box value: admin_app_id (8 bytes) + lp_interface_app_id (8 bytes) = 16 bytes
    accept_asa = Seq([
        Assert(is_admin),
        App.box_put(
            Itob(Btoi(Txn.application_args[1])),
            Concat(
                Itob(Btoi(Txn.application_args[2])),
                Itob(Btoi(Txn.application_args[3])),
            ),
        ),
        App.globalPut(NUM_ACCEPTED_KEY, App.globalGet(NUM_ACCEPTED_KEY) + Int(1)),
        Approve(),
    ])

    remove_asa = Seq([
        Assert(is_admin),
        Assert(App.box_delete(Itob(Btoi(Txn.application_args[1])))),
        App.globalPut(NUM_ACCEPTED_KEY, App.globalGet(NUM_ACCEPTED_KEY) - Int(1)),
        Approve(),
    ])

    # --- Exchange with DODO PMM pricing ---
    # Atomic group: [app_call(exchange), lofty_token_payment_to_escrow]
    # Foreign apps[1] = admin_app, Foreign apps[2] = lp_interface_app
    # Foreign assets must include the Lofty ASA and EARL ASA

    box_check = App.box_length(Itob(Gtxn[1].xfer_asset()))

    # Read from admin app: oracle_price (i) and k
    oracle_read = App.globalGetEx(Txn.applications[1], Bytes("oracle_price"))
    k_read = App.globalGetEx(Txn.applications[1], Bytes("k"))

    # Read from LP interface app: base_balance (B) and target_base_balance (B0)
    base_bal_read = App.globalGetEx(Txn.applications[2], Bytes("base_balance"))
    target_base_read = App.globalGetEx(Txn.applications[2], Bytes("target_base_balance"))

    exchange = Seq([
        Assert(paused == Int(0)),
        Assert(Global.group_size() == Int(2)),

        # Verify the Lofty token payment
        Assert(Gtxn[1].type_enum() == TxnType.AssetTransfer),
        Assert(Gtxn[1].asset_receiver() == Global.current_application_address()),
        Assert(Gtxn[1].asset_amount() > Int(0)),
        Assert(Gtxn[1].sender() == Txn.sender()),

        LOFTY_AMOUNT.store(Gtxn[1].asset_amount()),

        # Verify ASA is accepted
        box_check,
        Assert(box_check.hasValue()),

        # Verify KYC registry local state and blacklist status
        check_kyc_registry(),

        # Verify foreign apps match box storage:
        # Box = admin_app_id (first 8 bytes) + lp_interface_app_id (next 8 bytes)
        Assert(
            Btoi(App.box_extract(Itob(Gtxn[1].xfer_asset()), Int(0), Int(8)))
            == Txn.applications[1]
        ),
        Assert(
            Btoi(App.box_extract(Itob(Gtxn[1].xfer_asset()), Int(8), Int(8)))
            == Txn.applications[2]
        ),

        # Read DODO PMM parameters from on-chain state
        oracle_read,
        Assert(oracle_read.hasValue()),
        ORACLE_I.store(oracle_read.value()),
        Assert(ORACLE_I.load() > Int(0)),

        k_read,
        Assert(k_read.hasValue()),
        K_VAL.store(k_read.value()),

        base_bal_read,
        Assert(base_bal_read.hasValue()),
        BASE_BAL.store(base_bal_read.value()),
        Assert(BASE_BAL.load() > Int(0)),

        target_base_read,
        Assert(target_base_read.hasValue()),
        TARGET_BASE.store(target_base_read.value()),

        # Compute DODO PMM sell-base price:
        # P = i × (1 - k + k × (B0/B)²) / K_DENOM
        #
        # In integer math with K_DENOM = 1000000:
        # P = i × (K_DENOM - k + k × B0² / B²) / K_DENOM
        #
        # Use WideRatio to avoid overflow:
        # term1 = K_DENOM - k  (the constant part)
        # term2 = k × B0 × B0 / (B × B)  (the PMM adjustment)
        # P = i × (term1 + term2) / K_DENOM
        PMM_PRICE.store(
            WideRatio(
                [
                    ORACLE_I.load(),
                    K_DENOM - K_VAL.load() + WideRatio(
                        [K_VAL.load(), TARGET_BASE.load(), TARGET_BASE.load()],
                        [BASE_BAL.load(), BASE_BAL.load()],
                    ),
                ],
                [K_DENOM],
            )
        ),
        Assert(PMM_PRICE.load() > Int(0)),

        # EARL amount = lofty_tokens × pmm_price / earl_price
        EARL_AMOUNT.store(
            WideRatio(
                [LOFTY_AMOUNT.load(), PMM_PRICE.load()],
                [earl_price],
            )
        ),
        Assert(EARL_AMOUNT.load() > Int(0)),

        # Send EARL via inner transaction
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.AssetTransfer,
            TxnField.xfer_asset: earl_asa,
            TxnField.asset_amount: EARL_AMOUNT.load(),
            TxnField.asset_receiver: Txn.sender(),
            TxnField.fee: Int(0),
        }),
        InnerTxnBuilder.Submit(),

        Approve(),
    ])

    admin_withdraw = Seq([
        Assert(is_admin),
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.AssetTransfer,
            TxnField.xfer_asset: Btoi(Txn.application_args[1]),
            TxnField.asset_amount: Btoi(Txn.application_args[2]),
            TxnField.asset_receiver: Txn.sender(),
            TxnField.fee: Int(0),
        }),
        InnerTxnBuilder.Submit(),
        Approve(),
    ])

    admin_optin = Seq([
        Assert(is_admin),
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.AssetTransfer,
            TxnField.xfer_asset: Btoi(Txn.application_args[1]),
            TxnField.asset_amount: Int(0),
            TxnField.asset_receiver: Global.current_application_address(),
            TxnField.fee: Int(0),
        }),
        InnerTxnBuilder.Submit(),
        Approve(),
    ])

    admin_close_asset = Seq([
        Assert(is_admin),
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.AssetTransfer,
            TxnField.xfer_asset: Btoi(Txn.application_args[1]),
            TxnField.asset_amount: Int(0),
            TxnField.asset_receiver: Global.current_application_address(),
            TxnField.asset_close_to: Txn.sender(),
            TxnField.fee: Int(0),
        }),
        InnerTxnBuilder.Submit(),
        Approve(),
    ])

    admin_withdraw_algo = Seq([
        Assert(is_admin),
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.Payment,
            TxnField.amount: Btoi(Txn.application_args[1]),
            TxnField.receiver: Txn.sender(),
            TxnField.fee: Int(0),
        }),
        InnerTxnBuilder.Submit(),
        Approve(),
    ])

    method = Txn.application_args[0]
    on_call = Cond(
        [method == Bytes("setup"), setup],
        [method == Bytes("update_price"), update_price],
        [method == Bytes("update_registry"), update_registry],
        [method == Bytes("toggle_pause"), toggle_pause],
        [method == Bytes("accept_asa"), accept_asa],
        [method == Bytes("remove_asa"), remove_asa],
        [method == Bytes("exchange"), exchange],
        [method == Bytes("admin_withdraw"), admin_withdraw],
        [method == Bytes("admin_optin"), admin_optin],
        [method == Bytes("admin_close_asset"), admin_close_asset],
        [method == Bytes("admin_withdraw_algo"), admin_withdraw_algo],
    )

    program = Cond(
        [Txn.application_id() == Int(0), on_create],
        [Txn.on_completion() == OnComplete.NoOp, on_call],
        [Txn.on_completion() == OnComplete.UpdateApplication, Seq([Assert(is_admin), Approve()])],
        [Txn.on_completion() == OnComplete.DeleteApplication, Seq([Assert(is_admin), Approve()])],
        [Txn.on_completion() == OnComplete.OptIn, Approve()],
        [Txn.on_completion() == OnComplete.CloseOut, Approve()],
    )

    return program


def clear_state_program():
    return Approve()


if __name__ == "__main__":
    import os

    out_dir = os.path.join(os.path.dirname(__file__), "build")
    os.makedirs(out_dir, exist_ok=True)

    approval_teal = compileTeal(approval_program(), mode=Mode.Application, version=8)
    clear_teal = compileTeal(clear_state_program(), mode=Mode.Application, version=8)

    with open(os.path.join(out_dir, "inkind_exchange_approval.teal"), "w") as f:
        f.write(approval_teal)

    with open(os.path.join(out_dir, "inkind_exchange_clear.teal"), "w") as f:
        f.write(clear_teal)

    print(f"Compiled to {out_dir}/")
    print(f"Approval: {len(approval_teal)} bytes")
    print(f"Clear: {len(clear_teal)} bytes")
