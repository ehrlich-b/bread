// Scalar gate primitives and a reusable module, including positional ports.
module half_adder(input a, b, output sum, carry);
  xor sum_gate(sum, a, b);
  and carry_gate(carry, a, b);
endmodule

module full_adder(input a, b, cin, output sum, cout);
  wire ab, first_carry, second_carry;
  half_adder first(.a(a), .b(b), .sum(ab), .carry(first_carry));
  half_adder second(ab, cin, sum, second_carry);
  or carry_gate(cout, first_carry, second_carry);
endmodule
