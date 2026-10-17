//! htlc-tool: RGB assets locked on-chain in a two-leaf P2TR swap-tree HTLC and moved out of it.
//!
//! claim leaf:  OP_HASH160 <ripemd160(H)> OP_EQUALVERIFY <claim key> OP_CHECKSIG
//!              (H = sha256(P) is the Lightning payment hash, so HASH160(P) = RIPEMD160(H))
//! refund leaf: <refund key> OP_CHECKSIGVERIFY <timeout height> OP_CLTV
//! internal key: the BIP341 NUMS point, so there is no key-path spend.
//!
//! Adapted from kaleidoswap/rgb-lib@dbdf82d src/wallet/test/htlc_swap_tree.rs (lock through the
//! regular send with a witness recipient; spend with psbt_op_prepare and a hand-signed HTLC input
//! next to a wallet fee input) and kaleidoswap-sdk@385254a examples/rgb-regtest/src/wallet.rs
//! (manual PSBT, receive handover). The lock itself is done by an RLN node (/sendrgb).
//!
//! Every command prints one JSON object. Wallets live in /wallets/<name>. Regtest only.
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::PathBuf,
    str::FromStr,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, ensure, Context, Result};
use rgb_lib::{
    bitcoin::{
        absolute::LockTime,
        hashes::{ripemd160, Hash},
        key::{Keypair, XOnlyPublicKey},
        opcodes::all::{OP_CHECKSIG, OP_CHECKSIGVERIFY, OP_CLTV, OP_EQUALVERIFY, OP_HASH160},
        script::Builder,
        secp256k1::{All, Message, Secp256k1, SecretKey},
        sighash::{Prevouts, SighashCache, TapSighashType},
        taproot::{LeafVersion, Signature as TapSignature, TapLeafHash, TaprootBuilder, TaprootSpendInfo},
        transaction::Version,
        Address, Amount, Network, OutPoint, Psbt, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Witness,
    },
    generate_keys,
    keys::WitnessVersion,
    utils::{recipient_id_from_script_buf, script_buf_from_recipient_id},
    wallet::{
        rust_only::{AssetColoringInfo, ColoringInfo, ExpectedTransfer, PsbtOpExpiry},
        DatabaseType, Online, OnlineOptions, Recipient, RgbWalletOpsOffline, RgbWalletOpsOnline,
        SinglesigKeys, WalletData, WitnessData,
    },
    AssetSchema, Assignment, BitcoinNetwork, ContractId, Wallet,
};
use serde_json::{json, Value};

/// Sats on the HTLC output and on the colored payout of a spend.
const HTLC_SAT: u64 = 1_000;
/// Fee of a spend (HTLC input + one wallet input, three outputs), paid by the wallet input.
const SPEND_FEE_SAT: u64 = 1_500;
/// BIP341 "nothing up my sleeve" point: no one knows its discrete log.
const NUMS_XONLY: &str = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";

fn proxy() -> String {
    std::env::var("HT_PROXY").unwrap_or_else(|_| "rpc://proxy:3000/json-rpc".into())
}
fn indexer() -> String {
    std::env::var("HT_INDEXER").unwrap_or_else(|_| "electrs:50001".into())
}
fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

// ---------- the HTLC ----------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Path {
    Claim,
    Refund,
}

struct Htlc {
    secp: Secp256k1<All>,
    claim_leaf: ScriptBuf,
    refund_leaf: ScriptBuf,
    timeout: u32,
    spend_info: TaprootSpendInfo,
}

impl Htlc {
    fn new(payment_hash: &[u8; 32], claim: XOnlyPublicKey, refund: XOnlyPublicKey, timeout: u32) -> Result<Self> {
        let secp = Secp256k1::new();
        let hash160 = ripemd160::Hash::hash(payment_hash);
        let claim_leaf = Builder::new()
            .push_opcode(OP_HASH160)
            .push_slice(hash160.to_byte_array())
            .push_opcode(OP_EQUALVERIFY)
            .push_x_only_key(&claim)
            .push_opcode(OP_CHECKSIG)
            .into_script();
        let refund_leaf = Builder::new()
            .push_x_only_key(&refund)
            .push_opcode(OP_CHECKSIGVERIFY)
            .push_int(timeout as i64)
            .push_opcode(OP_CLTV)
            .into_script();
        let spend_info = TaprootBuilder::new()
            .add_leaf(1, claim_leaf.clone())?
            .add_leaf(1, refund_leaf.clone())?
            .finalize(&secp, XOnlyPublicKey::from_str(NUMS_XONLY)?)
            .map_err(|_| anyhow::anyhow!("taproot finalize"))?;
        Ok(Self { secp, claim_leaf, refund_leaf, timeout, spend_info })
    }
    fn from_args(a: &Args) -> Result<Self> {
        Self::new(
            &hex32(a.req("hash")?)?,
            XOnlyPublicKey::from_str(a.req("claim")?)?,
            XOnlyPublicKey::from_str(a.req("refund")?)?,
            a.req("timeout")?.parse()?,
        )
    }
    fn script_pubkey(&self) -> ScriptBuf {
        ScriptBuf::new_p2tr_tweaked(self.spend_info.output_key())
    }
    fn leaf(&self, path: Path) -> &ScriptBuf {
        match path {
            Path::Claim => &self.claim_leaf,
            Path::Refund => &self.refund_leaf,
        }
    }
    /// Script-path witness for input `index` of `tx`, sighash over all prevouts.
    fn witness(&self, tx: &Transaction, prevouts: &[TxOut], index: usize, path: Path, key: &Keypair, preimage: Option<[u8; 32]>) -> Result<Witness> {
        let leaf = self.leaf(path);
        let sighash = SighashCache::new(tx).taproot_script_spend_signature_hash(
            index,
            &Prevouts::All(prevouts),
            TapLeafHash::from_script(leaf, LeafVersion::TapScript),
            TapSighashType::Default,
        )?;
        let signature = TapSignature {
            signature: self.secp.sign_schnorr_no_aux_rand(&Message::from_digest(sighash.to_byte_array()), key),
            sighash_type: TapSighashType::Default,
        };
        let mut w = Witness::new();
        w.push(signature.to_vec());
        if path == Path::Claim {
            w.push(preimage.context("a claim needs the preimage")?);
        }
        w.push(leaf.as_bytes());
        let cb = self
            .spend_info
            .control_block(&(leaf.clone(), LeafVersion::TapScript))
            .context("control block")?;
        w.push(cb.serialize());
        Ok(w)
    }
}

fn hex32(s: &str) -> Result<[u8; 32]> {
    let v = hex::decode(s)?;
    v.try_into().map_err(|_| anyhow::anyhow!("expected 32 bytes hex"))
}
fn keypair(secret_hex: &str) -> Result<Keypair> {
    Ok(Keypair::from_secret_key(&Secp256k1::new(), &SecretKey::from_slice(&hex::decode(secret_hex)?)?))
}

// ---------- wallets ----------

fn open(name: &str) -> Result<(Wallet, Online)> {
    let root = PathBuf::from(std::env::var("HT_WALLETS").unwrap_or_else(|_| "/wallets".into())).join(name);
    fs::create_dir_all(&root)?;
    let keys_file = root.join("keys.json");
    if !keys_file.exists() {
        let k = generate_keys(BitcoinNetwork::Regtest, WitnessVersion::Taproot);
        fs::write(
            &keys_file,
            serde_json::to_string(&json!({
                "mnemonic": k.mnemonic, "account_xpub_vanilla": k.account_xpub_vanilla,
                "account_xpub_colored": k.account_xpub_colored, "master_fingerprint": k.master_fingerprint,
            }))?,
        )?;
    }
    let k: Value = serde_json::from_str(&fs::read_to_string(&keys_file)?)?;
    let s = |f: &str| k[f].as_str().unwrap().to_string();
    let keys = SinglesigKeys {
        account_xpub_vanilla: s("account_xpub_vanilla"),
        account_xpub_colored: s("account_xpub_colored"),
        vanilla_keychain: None,
        master_fingerprint: s("master_fingerprint"),
        mnemonic: Some(s("mnemonic")),
        witness_version: WitnessVersion::Taproot,
    };
    let mut wallet = Wallet::new(
        WalletData {
            data_dir: root.to_string_lossy().into(),
            bitcoin_network: BitcoinNetwork::Regtest,
            database_type: DatabaseType::Sqlite,
            max_allocations_per_utxo: 5,
            supported_schemas: vec![AssetSchema::Nia],
            reuse_addresses: false,
        },
        keys,
    )?;
    let online = wallet.go_online(OnlineOptions {
        indexer_url: indexer(),
        skip_consistency_check: false,
        vanilla_sync_lookback: 20,
    })?;
    Ok((wallet, online))
}

// ---------- commands ----------

struct Args(HashMap<String, String>);
impl Args {
    fn parse(v: &[String]) -> Result<Self> {
        let mut m = HashMap::new();
        let mut it = v.iter();
        while let Some(k) = it.next() {
            let k = k.strip_prefix("--").with_context(|| format!("unexpected argument {k}"))?;
            if k == "no-mark" {
                m.insert(k.into(), "1".into());
                continue;
            }
            m.insert(k.into(), it.next().with_context(|| format!("--{k} needs a value"))?.clone());
        }
        Ok(Self(m))
    }
    fn req(&self, k: &str) -> Result<&str> {
        self.0.get(k).map(|s| s.as_str()).with_context(|| format!("missing --{k}"))
    }
    fn has(&self, k: &str) -> bool {
        self.0.contains_key(k)
    }
}

fn keygen() -> Result<Value> {
    let mut b = [0u8; 32];
    fs::File::open("/dev/urandom")?.read_exact(&mut b)?;
    let kp = keypair(&hex::encode(b))?;
    Ok(json!({ "secret": hex::encode(b), "xonly": kp.x_only_public_key().0.to_string() }))
}

fn htlc_info(a: &Args) -> Result<Value> {
    let h = Htlc::from_args(a)?;
    let spk = h.script_pubkey();
    Ok(json!({
        "script_pubkey": spk.to_hex_string(),
        "address": Address::from_script(&spk, Network::Regtest)?.to_string(),
        "recipient_id": recipient_id_from_script_buf(spk, BitcoinNetwork::Regtest)?,
        "claim_leaf": h.claim_leaf.to_hex_string(),
        "refund_leaf": h.refund_leaf.to_hex_string(),
        "timeout": h.timeout,
    }))
}

/// Import the lock made by someone else (here: an RLN node) into this wallet, pinning the
/// consignment on the proxy to the HTLC output. rgb-lib validates it against the expected asset,
/// schema and amount.
fn accept(a: &Args) -> Result<Value> {
    let (mut w, online) = open(a.req("wallet")?)?;
    let rid = a.req("recipient-id")?.to_string();
    let asset_id = a.req("asset-id")?.to_string();
    let amount: u64 = a.req("amount")?.parse()?;
    let (consignment, assignments) = w.fetch_and_accept_transfer_by_recipient_id(
        online,
        rid.clone(),
        rid,
        &proxy(),
        a.req("blinding")?.parse()?,
        1,
        ExpectedTransfer { asset_id: asset_id.clone(), asset_schema: AssetSchema::Nia, assignment: Assignment::Fungible(amount) },
    )?;
    ensure!(assignments == vec![Assignment::Fungible(amount)], "lock assigns {assignments:?}");
    w.save_new_asset(online, consignment, a.req("lock-txid")?.to_string())?;
    let outpoint = OutPoint::from_str(a.req("outpoint")?)?;
    let rows = w.contract_assignments_for_outpoints(ContractId::from_str(&asset_id)?, vec![outpoint.into()])?;
    Ok(json!({ "assignments": format!("{assignments:?}"), "outpoint_rows": format!("{rows:?}") }))
}

/// Spend the HTLC through the claim or the refund leaf into a fresh witness receive of this
/// wallet, with a fee input from the wallet's vanilla side. Prints the signed transaction; the
/// caller broadcasts it (bitcoind RPC), mines, then calls `apply`.
fn spend(a: &Args) -> Result<Value> {
    let path = match a.req("path")? {
        "claim" => Path::Claim,
        "refund" => Path::Refund,
        p => bail!("--path claim|refund, not {p}"),
    };
    let htlc = Htlc::from_args(a)?;
    let key = keypair(a.req("secret")?)?;
    let preimage = a.0.get("preimage").map(|p| hex32(p)).transpose()?;
    let outpoint = OutPoint::from_str(a.req("outpoint")?)?;
    let asset_id = a.req("asset-id")?.to_string();
    let amount: u64 = a.req("amount")?.parse()?;
    let blinding: u64 = a.0.get("blinding").map(|b| b.parse()).transpose()?.unwrap_or(31337);
    let (mut w, online) = open(a.req("wallet")?)?;

    let receive = w.witness_receive(None, Assignment::Any, now() + 3600, vec![], 1)?;
    let dest = script_buf_from_recipient_id(receive.recipient_id.clone())?.context("witness script")?;
    let coin = w
        .list_unspents_vanilla(online, 1, false)?
        .into_iter()
        .filter(|u| u.txout.value.to_sat() > 10_000)
        .max_by_key(|u| u.txout.value)
        .context("no confirmed vanilla UTXO above 10000 sat for the fee")?;
    let change = Address::from_str(&w.get_address()?)?.require_network(Network::Regtest)?.script_pubkey();
    let htlc_txout = TxOut { value: Amount::from_sat(HTLC_SAT), script_pubkey: htlc.script_pubkey() };
    let tx = Transaction {
        version: Version::TWO,
        lock_time: match path {
            Path::Claim => LockTime::ZERO,
            Path::Refund => LockTime::from_height(htlc.timeout)?,
        },
        input: vec![
            TxIn { previous_output: outpoint, script_sig: ScriptBuf::new(), sequence: Sequence::ENABLE_RBF_NO_LOCKTIME, witness: Witness::new() },
            TxIn { previous_output: coin.outpoint, script_sig: ScriptBuf::new(), sequence: Sequence::ENABLE_RBF_NO_LOCKTIME, witness: Witness::new() },
        ],
        output: vec![
            TxOut { value: Amount::ZERO, script_pubkey: ScriptBuf::new_op_return([]) },
            TxOut { value: Amount::from_sat(HTLC_SAT), script_pubkey: dest },
            TxOut { value: coin.txout.value - Amount::from_sat(SPEND_FEE_SAT), script_pubkey: change },
        ],
    };
    let mut psbt = Psbt::from_unsigned_tx(tx)?;
    psbt.inputs[0].witness_utxo = Some(htlc_txout);
    psbt.inputs[1].witness_utxo = Some(coin.txout.clone());

    let op = w.psbt_op_prepare_with_expiry(
        &mut psbt,
        ColoringInfo {
            asset_info_map: HashMap::from([(
                ContractId::from_str(&asset_id)?,
                AssetColoringInfo { output_map: HashMap::from([(1u32, amount)]), static_blinding: Some(blinding) },
            )]),
            static_blinding: Some(blinding),
            nonce: None,
        },
        vec![outpoint],
        1,
        PsbtOpExpiry::Never,
    )?;
    let allocations = format!("{:?}", op.allocations);
    let mut psbt = Psbt::from_str(&op.colored_psbt)?;
    ensure!(psbt.unsigned_tx.output[0].script_pubkey.is_op_return(), "commitment must be output 0");
    let index = psbt
        .unsigned_tx
        .input
        .iter()
        .position(|i| i.previous_output == outpoint)
        .context("colored PSBT lost the HTLC input")?;
    let prevouts: Vec<TxOut> = psbt.inputs.iter().map(|i| i.witness_utxo.clone().unwrap()).collect();
    let witness = htlc.witness(&psbt.unsigned_tx, &prevouts, index, path, &key, preimage)?;
    psbt.inputs[index].final_script_witness = Some(witness.clone());
    let signed = w.sign_psbt(psbt.to_string(), None)?;
    let finalized = Psbt::from_str(&w.finalize_psbt(signed, None)?)?;
    ensure!(finalized.inputs[index].final_script_witness == Some(witness), "wallet changed the HTLC witness");
    let tx = finalized.extract_tx()?;
    if !a.has("no-mark") {
        w.psbt_op_mark_broadcast(&op.operation_id)?;
    }
    Ok(json!({
        "operation_id": op.operation_id,
        "txid": tx.compute_txid().to_string(),
        "tx_hex": hex::encode(rgb_lib::bitcoin::consensus::serialize(&tx)),
        "lock_time": tx.lock_time.to_consensus_u32(),
        "allocations": allocations,
        "dest_recipient_id": receive.recipient_id,
    }))
}

/// After the spend confirmed: apply the operation and hand its consignment to our own receive.
fn apply(a: &Args) -> Result<Value> {
    let (mut w, online) = open(a.req("wallet")?)?;
    let op = a.req("op")?;
    w.psbt_op_apply(online, op)?;
    let r = w.psbt_op_provide_receive_consignment(online, op, a.req("asset-id")?)?;
    Ok(json!({ "provided": format!("{r:?}") }))
}

fn abort(a: &Args) -> Result<Value> {
    let (mut w, online) = open(a.req("wallet")?)?;
    w.psbt_op_abort(online, a.req("op")?)?;
    Ok(json!({ "aborted": a.req("op")? }))
}

fn balance(a: &Args) -> Result<Value> {
    let (mut w, online) = open(a.req("wallet")?)?;
    let asset_id = a.0.get("asset-id").cloned();
    let refreshed = w.refresh(online, None, vec![], false)?;
    let bal = match asset_id {
        Some(id) => match w.get_asset_balance(id) {
            Ok(b) => json!({ "settled": b.settled, "future": b.future, "spendable": b.spendable }),
            Err(e) => json!({ "error": e.to_string() }),
        },
        None => Value::Null,
    };
    let btc = w.get_btc_balance(Some(online), false)?;
    Ok(json!({ "asset": bal, "btc_vanilla_spendable": btc.vanilla.spendable, "refreshed": format!("{refreshed:?}") }))
}

fn address(a: &Args) -> Result<Value> {
    let (mut w, _) = open(a.req("wallet")?)?;
    Ok(json!({ "address": w.get_address()? }))
}

fn create_utxos(a: &Args) -> Result<Value> {
    let (mut w, online) = open(a.req("wallet")?)?;
    let n = w.create_utxos(online, true, Some(a.req("num")?.parse()?), Some(a.req("size")?.parse()?), 2, false)?;
    Ok(json!({ "created": n }))
}

/// Regular RGB send to a blinded receive (an RLN node's /rgbinvoice).
fn send(a: &Args) -> Result<Value> {
    let (mut w, online) = open(a.req("wallet")?)?;
    let res = w.send(
        online,
        HashMap::from([(
            a.req("asset-id")?.to_string(),
            vec![Recipient {
                recipient_id: a.req("recipient-id")?.to_string(),
                witness_data: a.0.get("witness-sat").map(|s| s.parse()).transpose()?.map(|amount_sat| WitnessData { amount_sat, blinding: None }),
                assignment: Assignment::Fungible(a.req("amount")?.parse()?),
                transport_endpoints: vec![proxy()],
            }],
        )]),
        true,
        2,
        1,
        now() + 3600,
        None,
    )?;
    Ok(json!({ "txid": res.txid }))
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let res = (|| -> Result<Value> {
        let (cmd, rest) = argv.split_first().context("usage: htlc-tool <command> [--key value ...]")?;
        let a = Args::parse(rest)?;
        match cmd.as_str() {
            "keygen" => keygen(),
            "htlc" => htlc_info(&a),
            "address" => address(&a),
            "create-utxos" => create_utxos(&a),
            "accept" => accept(&a),
            "spend" => spend(&a),
            "apply" => apply(&a),
            "abort" => abort(&a),
            "balance" => balance(&a),
            "send" => send(&a),
            c => bail!("unknown command {c}"),
        }
    })();
    match res {
        Ok(v) => println!("{v}"),
        Err(e) => {
            println!("{}", json!({ "error": format!("{e:#}") }));
            std::process::exit(1);
        }
    }
}
