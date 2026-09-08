use yrs::encoding::read::Cursor;
use yrs::Any;

#[test]
fn any_signed_integers_preserve_zero_sign_and_ordinary_wire_bytes() {
    for (value, expected) in [
        (-0.0, vec![125, 64]),
        (0.0, vec![125, 0]),
        (-1.0, vec![125, 65]),
        (1.0, vec![125, 1]),
        (-63.0, vec![125, 127]),
        (63.0, vec![125, 63]),
        (-64.0, vec![125, 192, 1]),
        (64.0, vec![125, 128, 1]),
    ] {
        let mut bytes = Vec::new();
        Any::Number(value).encode(&mut bytes);
        assert_eq!(bytes, expected);
        let Any::Number(decoded) = Any::decode(&mut Cursor::new(&bytes)).unwrap() else {
            panic!("number")
        };
        assert_eq!(decoded.to_bits(), value.to_bits());
    }
    for value in [-9_007_199_254_740_991.0, 9_007_199_254_740_991.0] {
        let mut bytes = Vec::new();
        Any::Number(value).encode(&mut bytes);
        let Any::Number(decoded) = Any::decode(&mut Cursor::new(&bytes)).unwrap() else {
            panic!("number")
        };
        assert_eq!(decoded, value);
        assert_eq!(bytes[0], 125);
    }
}
