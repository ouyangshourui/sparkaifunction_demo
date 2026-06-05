"""seed：写入演示数据。
- reviews   电商评论
- tickets   客服工单
"""
from pyspark.sql import SparkSession
from pyspark.sql.types import StructType, StructField, StringType, IntegerType


REVIEWS = [
    # —— 第一批 30 条（中英混合 · CN/US/UK）——
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
    # —— 第二批 30 条（更多 sales > 1000 命中行，让 Demo Act1/Act2 谓词下推有数据）——
    ("r031", "材质很扎实，做工精致，物超所值。", "zh", "CN", 1850),
    ("r032", "Arrived on time, packaging well done.", "en", "US", 1920),
    ("r033", "续航非常给力，能用一整天。", "zh", "CN", 1450),
    ("r034", "Sound quality is amazing for the price.", "en", "UK", 1780),
    ("r035", "屏幕清晰，色彩鲜艳，不错。", "zh", "CN", 2150),
    ("r036", "Battery drains way too fast.", "en", "US", 680),
    ("r037", "速度有点慢，但稳定不卡顿。", "zh", "CN", 1080),
    ("r038", "Customer service was super helpful.", "en", "US", 2450),
    ("r039", "包装很豪华，送礼很合适。", "zh", "CN", 2890),
    ("r040", "Returned within an hour, total scam.", "en", "US", 90),
    ("r041", "性能强劲，玩游戏也不卡。", "zh", "CN", 3100),
    ("r042", "Looks cheap, feels cheap, is cheap.", "en", "UK", 280),
    ("r043", "搭配 App 体验很好。", "zh", "CN", 1390),
    ("r044", "Setup was confusing but works fine now.", "en", "US", 1620),
    ("r045", "保修服务靠谱，已经修好了。", "zh", "CN", 1750),
    ("r046", "App keeps crashing on startup.", "en", "US", 540),
    ("r047", "重量很轻，便携性满分。", "zh", "CN", 1330),
    ("r048", "Honestly the best in this price range.", "en", "UK", 1890),
    ("r049", "颜色和图片有差别，差评。", "zh", "CN", 410),
    ("r050", "Shipping took forever, almost canceled.", "en", "US", 730),
    ("r051", "续航超长，出差党刚需。", "zh", "CN", 2280),
    ("r052", "Build quality is rock solid.", "en", "US", 2670),
    ("r053", "音质很棒，低音很有冲击力。", "zh", "CN", 1980),
    ("r054", "Stopped charging after a month.", "en", "US", 1190),
    ("r055", "客服回复神速，问题秒解决。", "zh", "CN", 1560),
    ("r056", "Looks great, performance is meh.", "en", "UK", 1280),
    ("r057", "外观惊艳，做工细腻。", "zh", "CN", 2120),
    ("r058", "Total waste of money, do not buy.", "en", "US", 320),
    ("r059", "买给爸妈用，他们很喜欢。", "zh", "CN", 1480),
    ("r060", "Premium feel at a budget price.", "en", "UK", 1650),
    # —— 第三批 40 条（多种语言情绪混合，让 ai_classify 真正有挑战）——
    ("r061", "用了半年没坏，质量过硬。", "zh", "CN", 1940),
    ("r062", "Crashed twice, but support fixed it.", "en", "US", 1240),
    ("r063", "包装实在太简陋了。", "zh", "CN", 580),
    ("r064", "Nothing special, just average.", "en", "UK", 770),
    ("r065", "拍照效果惊艳，朋友圈神器。", "zh", "CN", 2290),
    ("r066", "Fits perfectly, exactly as described.", "en", "US", 1880),
    ("r067", "续航缩水严重，差评。", "zh", "CN", 360),
    ("r068", "Charging port broke in week one.", "en", "US", 460),
    ("r069", "整体满意，会推荐给朋友。", "zh", "CN", 1750),
    ("r070", "Great value, fast delivery, will reorder.", "en", "US", 2360),
    ("r071", "和宣传完全不一样，气死。", "zh", "CN", 250),
    ("r072", "Bought 2, both work flawlessly.", "en", "UK", 2890),
    ("r073", "做工对得起这个价格。", "zh", "CN", 1290),
    ("r074", "Returned, not what I expected.", "en", "US", 690),
    ("r075", "颜值党会喜欢这个外观。", "zh", "CN", 2140),
    ("r076", "Way more durable than I thought.", "en", "US", 1980),
    ("r077", "客服踢皮球，问题没解决。", "zh", "CN", 410),
    ("r078", "Smooth experience from start to finish.", "en", "UK", 2050),
    ("r079", "值得回购的好东西。", "zh", "CN", 1870),
    ("r080", "Manual is in Chinese, hard to follow.", "en", "US", 920),
    ("r081", "充电速度比想象中快。", "zh", "CN", 1620),
    ("r082", "Doesn't work with my old phone, sad.", "en", "US", 1140),
    ("r083", "颜色超正，不偏色。", "zh", "CN", 1990),
    ("r084", "Speakers blew out within two weeks.", "en", "UK", 870),
    ("r085", "懒人福音，操作太简单了。", "zh", "CN", 1380),
    ("r086", "Solid hardware but software is buggy.", "en", "US", 1430),
    ("r087", "送了好几个赠品，惊喜。", "zh", "CN", 2480),
    ("r088", "Exactly what the photos showed.", "en", "US", 1720),
    ("r089", "买回来发现是翻新机，差评。", "zh", "CN", 380),
    ("r090", "Packed neatly, no scratches.", "en", "UK", 1880),
    ("r091", "实际尺寸比图片小一点。", "zh", "CN", 970),
    ("r092", "Excellent customer experience overall.", "en", "US", 2740),
    ("r093", "夜间模式很暖心。", "zh", "CN", 1560),
    ("r094", "Charger died, had to buy a new one.", "en", "US", 1090),
    ("r095", "外包装可以再讲究一下。", "zh", "CN", 850),
    ("r096", "Insanely fast delivery, kudos!", "en", "UK", 2010),
    ("r097", "用着用着就习惯了，还行。", "zh", "CN", 1240),
    ("r098", "Honestly, expected more for the price.", "en", "US", 1180),
    ("r099", "礼品装很高级，朋友很惊喜。", "zh", "CN", 2860),
    ("r100", "Five star service all around.", "en", "US", 2620),
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
