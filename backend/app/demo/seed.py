"""seed：写入演示数据。
- reviews   电商评论
- tickets   客服工单
"""
from pyspark.sql import SparkSession
from pyspark.sql.types import StructType, StructField, StringType, IntegerType


REVIEWS = [
    ("r001", "物流超快，包装精美，强烈推荐！", "zh", "CN", 1280),
    ("r002", "Product broke after 2 days, terrible quality.", "en", "US", 1500),
    ("r003", "一般般，价格偏贵，但是功能齐全。", "zh", "CN", 980),
    ("r004", "Excellent service, will buy again.", "en", "US", 2100),
    ("r005", "客服态度差，发货也慢。", "zh", "CN", 320),
    ("r006", "Mediocre experience, nothing special.", "en", "UK", 760),
    ("r007", "性价比超高，五星好评！", "zh", "CN", 1899),
    ("r008", "Color is different from the picture.", "en", "US", 1100),
    ("r009", "包装破损但产品没事，凑合用了。", "zh", "CN", 540),
    ("r010", "Best purchase this year!", "en", "US", 3200),
    ("r011", "完全不能用，差评！", "zh", "CN", 220),
    ("r012", "Pretty good for the price.", "en", "UK", 880),
    ("r013", "用了一周还行，没出问题。", "zh", "CN", 1150),
    ("r014", "Way overpriced for what you get.", "en", "US", 1480),
    ("r015", "图片仅供参考是吧？买回来失望。", "zh", "CN", 670),
    ("r016", "Five stars all the way!", "en", "US", 2400),
    ("r017", "马马虎虎，不算特别好。", "zh", "CN", 990),
    ("r018", "Stopped working in 3 days.", "en", "US", 1320),
    ("r019", "颜值很高，老婆喜欢。", "zh", "CN", 1670),
    ("r020", "Solid product, recommend it.", "en", "UK", 2050),
    ("r021", "速度比预期慢，但还能接受。", "zh", "CN", 760),
    ("r022", "Fantastic build quality.", "en", "US", 2700),
    ("r023", "差评，再也不买了。", "zh", "CN", 130),
    ("r024", "Decent value for money.", "en", "UK", 940),
    ("r025", "外观不错，功能简单。", "zh", "CN", 1180),
    ("r026", "Disappointing, returning it.", "en", "US", 510),
    ("r027", "用了三个月很满意。", "zh", "CN", 1420),
    ("r028", "Customer support was terrible.", "en", "US", 220),
    ("r029", "完美，没毛病。", "zh", "CN", 1990),
    ("r030", "Average product, average service.", "en", "UK", 870),
]

TICKETS = [
    ("t001", "我买的耳机左边没声音，能不能换货？", "P1"),
    ("t002", "I want a refund, the item never arrived.", "P0"),
    ("t003", "请问什么时候发货？已经下单 3 天了。", "P2"),
    ("t004", "登录不了账号，提示密码错误。", "P1"),
    ("t005", "Can you tell me how to use the discount code?", "P3"),
    ("t006", "发票还没收到，急用。", "P2"),
    ("t007", "我刚下单的订单可以改地址吗？", "P2"),
    ("t008", "App 闪退，无法下单。", "P1"),
    ("t009", "How to cancel my subscription?", "P2"),
    ("t010", "包裹丢了，物流显示已签收。", "P0"),
    ("t011", "购买的商品和描述不一致。", "P1"),
    ("t012", "Need invoice for my order.", "P3"),
    ("t013", "申请售后但是一直没人处理。", "P0"),
    ("t014", "Promo code not working.", "P3"),
    ("t015", "Want to change shipping address.", "P2"),
    ("t016", "我能不能加急配送？", "P3"),
    ("t017", "Order arrived but item is broken.", "P1"),
    ("t018", "如何申请退款？", "P2"),
    ("t019", "Why is my account locked?", "P1"),
    ("t020", "请联系我处理售后问题。", "P2"),
]


def seed(spark: SparkSession) -> None:
    schema_r = StructType(
        [
            StructField("id", StringType(), False),
            StructField("text", StringType(), False),
            StructField("lang", StringType(), False),
            StructField("country", StringType(), False),
            StructField("sales", IntegerType(), False),
        ]
    )
    schema_t = StructType(
        [
            StructField("id", StringType(), False),
            StructField("content", StringType(), False),
            StructField("priority", StringType(), False),
        ]
    )

    # 确保 namespace
    spark.sql("CREATE NAMESPACE IF NOT EXISTS local.default")

    # 写入（drop 重建保证幂等）
    spark.sql("DROP TABLE IF EXISTS local.default.reviews")
    spark.createDataFrame(REVIEWS, schema_r).writeTo(
        "local.default.reviews"
    ).using("iceberg").create()

    spark.sql("DROP TABLE IF EXISTS local.default.tickets")
    spark.createDataFrame(TICKETS, schema_t).writeTo(
        "local.default.tickets"
    ).using("iceberg").create()

    # 切到 default namespace，让裸表名查询能命中
    spark.sql("USE local.default")
    print("[seed] reviews & tickets written to Iceberg.")
